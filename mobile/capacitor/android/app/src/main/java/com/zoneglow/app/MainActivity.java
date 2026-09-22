package com.zoneglow.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(HubBlePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

