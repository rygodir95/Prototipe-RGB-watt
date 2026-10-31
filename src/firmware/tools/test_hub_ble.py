#!/usr/bin/env python3
"""Hub BLE tests: host transfer state machine + source invariants.

1. Compiles and runs tools/tests/hub_ble/test.cpp (HubBleTransfer and the
   advertising policy, no hardware and no Arduino dependency).
2. Checks the source invariants this fix depends on, so a later edit cannot
   silently reintroduce the shared transfer slot, drop the October mutex fixes
   or forget the second NimBLE connection.

Usage: python tools/test_hub_ble.py
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

FIRMWARE = pathlib.Path(__file__).resolve().parents[1]


def run_host_test():
    source = FIRMWARE / "tools" / "tests" / "hub_ble" / "test.cpp"
    if not source.exists():
        raise SystemExit("missing host test source: %s" % source)
    workdir = pathlib.Path(tempfile.mkdtemp())
    binary = workdir / "test_hub_ble"
    compiler = shutil.which("g++") or shutil.which("clang++")
    if compiler:
        subprocess.check_call([compiler, "-std=c++14", "-O1", "-Wall", "-Wextra",
                               "-o", str(binary), str(source)])
        subprocess.check_call([str(binary)])
        return
    print("FAIL: no C++ compiler (g++/clang++) found; cannot run the host test")
    raise SystemExit(1)


def read(relative):
    return (FIRMWARE / relative).read_text(encoding="utf-8")


def check_invariants():
    failures = []

    def expect(condition, message):
        if not condition:
            failures.append(message)

    hub_cpp = read("src/HubBleLink.cpp")
    hub_h = read("include/HubBleLink.h")
    transfer_h = read("include/HubBleTransfer.h")
    platformio = read("platformio.ini")
    host_bridge = read("tools/ble_web_host.js")

    # Hub GATT service contract (Task 1).
    for uuid in ("5ca90000-6d75-4ca5-b4d6-3f9e6c5b0001",
                 "5ca90001-6d75-4ca5-b4d6-3f9e6c5b0001",
                 "5ca90002-6d75-4ca5-b4d6-3f9e6c5b0001",
                 "5ca90003-6d75-4ca5-b4d6-3f9e6c5b0001"):
        expect(uuid in hub_cpp, "HubBleLink.cpp is missing service/characteristic %s" % uuid)
    expect("Training Hub" in hub_h, "advertised name 'Training Hub' missing from HubBleLink.h")

    # Independent transfer state (Task 2): no shared payload slot anywhere.
    expect("_transferPayload" not in hub_cpp and "_transferPayload" not in hub_h,
           "HubBleLink still uses the shared _transferPayload slot")
    expect("HubBleTransfer _transfer" in hub_h, "HubBleLink does not own a HubBleTransfer")
    expect("KIND_COUNT = 2" in transfer_h, "HubBleTransfer is not two independent slots")
    expect("kExpiryMs   = 60000" in transfer_h.replace("  ", " ") or "kExpiryMs" in transfer_h,
           "HubBleTransfer lost the 60 s expiry")
    expect("hubBleTransferDoesNotClear" not in transfer_h, "unexpected transfer helper")
    # The final page must not clear the slot: no clear() call inside sendPage.
    send_page = hub_cpp.split("void HubBleLink::sendPage", 1)[-1].split("void HubBleLink::publishStatus", 1)[0]
    expect(".clear" not in send_page, "sendPage() clears the transfer after the final page")

    # Advertising must report failure and restart after disconnect (Task 4).
    expect("advertising FAILED" in hub_cpp, "advertising failure is not reported")
    on_disconnect = hub_cpp.split("void HubBleLink::onDisconnect", 1)[-1].split("void HubBleLink::loop", 1)[0]
    expect("startAdvertising(true)" in on_disconnect, "advertising is not restarted after disconnect")
    expect("CONFIG_BT_NIMBLE_MAX_CONNECTIONS=2" in platformio,
           "platformio.ini must allow two NimBLE connections (sensor + control client)")

    # October mutex/synchronization fixes preserved (Task 4).
    for module in ("src/BLEPower.cpp", "src/HRSensor.cpp"):
        expect("xSemaphoreCreateMutex" in read(module),
               "%s lost its mutex synchronisation (October fixes)" % module)

    # Config policy is shared, not duplicated (Task 1 adaptation).
    config_json = read("include/ConfigJson.h")
    expect("buildConfigJson" in config_json and "applyConfigPatch" in config_json,
           "ConfigJson.h does not expose the shared config helpers")
    expect("#include \"ConfigJson.h\"" in read("src/WebInterface.cpp"),
           "WebInterface.cpp does not use the shared config helpers")

    # Bounded client retry (Task 3).
    expect("TRANSFER_RETRY_LIMIT = 1" in host_bridge, "client retry limit is not 1")
    expect("isTransferFailure" in host_bridge, "client retry does not gate on transfer failures")

    # Hub server is wired into the firmware main loop.
    main_cpp = read("src/main.cpp")
    expect("hubBle.begin()" in main_cpp and "hubBle.loop()" in main_cpp,
           "main.cpp does not start/service the hub BLE link")

    if failures:
        print("FAIL: source invariants")
        for item in failures:
            print("  - " + item)
        raise SystemExit(1)
    print("source invariants        ok")


if __name__ == "__main__":
    run_host_test()
    check_invariants()
    print("hub ble tests passed")
