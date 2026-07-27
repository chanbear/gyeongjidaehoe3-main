package com.ondam.app;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 문자 앱을 "새 메시지 작성" 화면이 아니라 앱 자체(대화 목록)로 여는 전용 플러그인.
 * sms: URL 스킴은 항상 작성 화면을 열기 때문에, 실제 문자 앱을 열 때는 이 플러그인을 우선 사용한다.
 */
@CapacitorPlugin(name = "MessagingLauncher")
public class MessagingLauncherPlugin extends Plugin {

    @PluginMethod
    public void openMessagingApp(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_MAIN);
            intent.addCategory(Intent.CATEGORY_APP_MESSAGING);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("문자 앱을 열 수 없습니다: " + e.getMessage());
        }
    }
}
