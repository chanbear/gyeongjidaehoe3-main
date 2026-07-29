package com.ondam.app;

import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Settings;
import android.provider.Telephony;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 문자 수신함을 읽어와 복사/붙여넣기 없이 바로 확인할 수 있게 해주는 플러그인.
 * READ_SMS 권한이 필요하며, 이 권한은 Google Play 정책상 기본 문자 앱만 쓸 수 있어
 * 경진대회 심사용 APK에서만 사용한다(스토어 출시 앱에는 넣지 않음).
 * checkPermissions()/requestPermissions()는 Capacitor의 Plugin 기본 클래스가
 * 아래 @Permission 선언을 보고 자동으로 구현해준다 — 따로 오버라이드하지 않는다.
 */
@CapacitorPlugin(
    name = "SmsReader",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_SMS }, alias = "sms")
    }
)
public class SmsReaderPlugin extends Plugin {

    @PluginMethod
    public void getRecentMessages(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("READ_SMS permission not granted");
            return;
        }
        int limit = call.getInt("limit", 30);
        JSArray messages = new JSArray();
        Cursor cursor = getContext().getContentResolver().query(
            Telephony.Sms.Inbox.CONTENT_URI,
            new String[] {
                Telephony.Sms.Inbox._ID,
                Telephony.Sms.Inbox.ADDRESS,
                Telephony.Sms.Inbox.BODY,
                Telephony.Sms.Inbox.DATE
            },
            null, null,
            Telephony.Sms.Inbox.DATE + " DESC"
        );
        if (cursor != null) {
            try {
                int count = 0;
                while (cursor.moveToNext() && count < limit) {
                    JSObject msg = new JSObject();
                    msg.put("id", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox._ID)));
                    msg.put("address", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.ADDRESS)));
                    msg.put("body", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.BODY)));
                    msg.put("date", cursor.getLong(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.DATE)));
                    messages.put(msg);
                    count++;
                }
            } finally {
                cursor.close();
            }
        }
        JSObject result = new JSObject();
        result.put("messages", messages);
        call.resolve(result);
    }

    /** 한 번 거부 후 "다시 묻지 않음"까지 선택하면 시스템 권한 다이얼로그가 다시 뜨지 않는
     *  Android 정책 때문에 필요 — 사용자가 직접 앱 설정에서 권한을 켜도록 안내한다. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
