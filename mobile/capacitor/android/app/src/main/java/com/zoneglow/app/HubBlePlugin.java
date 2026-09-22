package com.zoneglow.app;

import android.Manifest;
import android.content.Context;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

// Native Android transport for the Hub's small, versioned local GATT service.
// It deliberately exposes only discovery, connection, status/result events and
// JSON commands. The web UI remains the Wi-Fi secondary path.
@CapacitorPlugin(
    name = "HubBle",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT
        })
    }
)
public class HubBlePlugin extends Plugin {
    private static final UUID SERVICE_UUID = UUID.fromString("5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001");
    private static final UUID STATUS_UUID  = UUID.fromString("5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001");
    private static final UUID COMMAND_UUID = UUID.fromString("5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001");
    private static final UUID RESULT_UUID  = UUID.fromString("5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001");
    private static final UUID CCCD_UUID    = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, JSObject> found = new LinkedHashMap<>();
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic command;
    private final List<BluetoothGattCharacteristic> subscriptions = new ArrayList<>();
    private PluginCall pendingConnect;
    private PluginCall pendingWrite;

    @Override
    public void load() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
    }

    @PluginMethod
    public void requestBluetoothPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || hasPermission("bluetooth")) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("bluetooth", call, "permissionsResult");
    }

    @PermissionCallback
    private void permissionsResult(PluginCall call) {
        if (hasPermission("bluetooth")) call.resolve();
        else call.reject("Bluetooth permission denied");
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (!ready(call)) return;
        if (!adapter.isEnabled()) { call.reject("Bluetooth is disabled"); return; }
        if (scanner != null) stopScan();
        found.clear();
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("BLE scanner unavailable"); return; }
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            scanner.startScan(filters, settings, scanCallback);
        } catch (SecurityException error) {
            call.reject("Bluetooth permission denied", error);
            return;
        }
        handler.postDelayed(() -> {
            stopScan();
            JSArray devices = new JSArray();
            for (JSObject device : found.values()) devices.put(device);
            JSObject result = new JSObject(); result.put("devices", devices);
            call.resolve(result);
        }, 6000);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!ready(call)) return;
        String address = call.getString("address", "");
        if (address.isEmpty()) { call.reject("address is required"); return; }
        disconnectGatt();
        try {
            BluetoothDevice device = adapter.getRemoteDevice(address);
            pendingConnect = call;
            gatt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                : device.connectGatt(getContext(), false, gattCallback);
            if (gatt == null) { pendingConnect = null; call.reject("could not start BLE connection"); }
        } catch (IllegalArgumentException | SecurityException error) {
            pendingConnect = null;
            call.reject("could not connect to device", error);
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectGatt();
        call.resolve();
    }

    @PluginMethod
    public void command(PluginCall call) {
        if (command == null || gatt == null) { call.reject("Hub is not connected"); return; }
        String message = call.getString("message", "");
        if (message.isEmpty() || message.length() > 180) { call.reject("invalid command"); return; }
        try {
            command.setValue(message.getBytes(StandardCharsets.UTF_8));
            command.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            pendingWrite = call;
            if (!gatt.writeCharacteristic(command)) {
                pendingWrite = null;
                call.reject("command write was not accepted");
            }
        } catch (SecurityException error) {
            pendingWrite = null;
            call.reject("Bluetooth permission denied", error);
        }
    }

    private boolean ready(PluginCall call) {
        if (adapter == null) { call.reject("Bluetooth is unavailable"); return false; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasPermission("bluetooth")) {
            call.reject("Bluetooth permission not granted"); return false;
        }
        return true;
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            JSObject item = new JSObject();
            item.put("address", device.getAddress());
            item.put("name", device.getName() == null ? "Training Hub" : device.getName());
            item.put("rssi", result.getRssi());
            found.put(device.getAddress(), item);
            notifyListeners("hubFound", item);
        }
        @Override public void onScanFailed(int errorCode) {
            JSObject event = new JSObject(); event.put("error", "scan failed: " + errorCode);
            notifyListeners("bleError", event);
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt connection, int status, int newState) {
            if (status != BluetoothGatt.GATT_SUCCESS || newState != BluetoothProfile.STATE_CONNECTED) {
                rejectConnect("connection failed (" + status + ")");
                emitConnection(false); return;
            }
            // Configuration and zone commands need more than the default 23-byte ATT MTU.
            try { if (!connection.requestMtu(247)) rejectConnect("Could not negotiate Bluetooth message size"); }
            catch (SecurityException error) { rejectConnect("Bluetooth permission denied"); }
        }

        @Override public void onMtuChanged(BluetoothGatt connection, int mtu, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS || mtu < 185) {
                rejectConnect("Hub requires a Bluetooth MTU of at least 185 bytes"); return;
            }
            try { connection.discoverServices(); }
            catch (SecurityException error) { rejectConnect("Bluetooth permission denied"); }
        }

        @Override public void onServicesDiscovered(BluetoothGatt connection, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS || connection.getService(SERVICE_UUID) == null) {
                rejectConnect("Hub BLE service not found"); return;
            }
            command = connection.getService(SERVICE_UUID).getCharacteristic(COMMAND_UUID);
            BluetoothGattCharacteristic statusCharacteristic = connection.getService(SERVICE_UUID).getCharacteristic(STATUS_UUID);
            BluetoothGattCharacteristic resultCharacteristic = connection.getService(SERVICE_UUID).getCharacteristic(RESULT_UUID);
            if (command == null || statusCharacteristic == null || resultCharacteristic == null) {
                rejectConnect("Hub BLE service is incomplete"); return;
            }
            subscriptions.clear();
            subscriptions.add(statusCharacteristic);
            subscriptions.add(resultCharacteristic);
            enableNextNotification(connection);
        }

        @Override public void onCharacteristicChanged(BluetoothGatt connection, BluetoothGattCharacteristic characteristic) {
            String message = new String(characteristic.getValue(), StandardCharsets.UTF_8);
            try {
                JSObject event = new JSObject(message);
                notifyListeners(characteristic.getUuid().equals(STATUS_UUID) ? "status" : "result", event);
            } catch (JSONException error) {
                JSObject event = new JSObject(); event.put("error", "invalid Hub message");
                notifyListeners("bleError", event);
            }
        }

        @Override public void onCharacteristicWrite(BluetoothGatt connection, BluetoothGattCharacteristic characteristic, int status) {
            if (pendingWrite == null) return;
            if (status == BluetoothGatt.GATT_SUCCESS) pendingWrite.resolve();
            else pendingWrite.reject("command write failed (" + status + ")");
            pendingWrite = null;
        }

        @Override public void onDescriptorWrite(BluetoothGatt connection, BluetoothGattDescriptor descriptor, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                rejectConnect("Could not subscribe to Hub updates");
                return;
            }
            enableNextNotification(connection);
        }
    };

    private void enableNextNotification(BluetoothGatt connection) {
        if (subscriptions.isEmpty()) {
            if (pendingConnect != null) {
                JSObject result = new JSObject(); result.put("connected", true);
                pendingConnect.resolve(result); pendingConnect = null;
            }
            emitConnection(true);
            return;
        }
        BluetoothGattCharacteristic characteristic = subscriptions.remove(0);
        try {
            connection.setCharacteristicNotification(characteristic, true);
            BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CCCD_UUID);
            if (descriptor != null) {
                descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                if (!connection.writeDescriptor(descriptor)) {
                    rejectConnect("Could not subscribe to Hub updates");
                }
            } else {
                enableNextNotification(connection);
            }
        } catch (SecurityException error) {
            rejectConnect("Bluetooth permission denied");
        }
    }

    private void rejectConnect(String message) {
        if (pendingConnect != null) { pendingConnect.reject(message); pendingConnect = null; }
        disconnectGatt();
    }

    private void emitConnection(boolean connected) {
        JSObject event = new JSObject(); event.put("connected", connected);
        notifyListeners("connection", event);
    }

    private void stopScan() {
        if (scanner == null) return;
        try { scanner.stopScan(scanCallback); } catch (SecurityException ignored) {}
        scanner = null;
    }

    private void disconnectGatt() {
        command = null;
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (SecurityException ignored) {}
            gatt = null;
        }
    }
}

