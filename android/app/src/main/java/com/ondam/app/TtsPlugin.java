package com.ondam.app;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * 안드로이드 네이티브 TTS(android.speech.tts.TextToSpeech)로 음성 안내를 읽어준다.
 * 안드로이드 시스템 WebView는 웹 표준 Web Speech API(window.speechSynthesis)를 안정적으로
 * 지원하지 않아(기기별로 아예 무음이거나 getVoices()가 빈 배열을 반환) APK에서는 음성 안내가
 * 나오지 않는 문제가 있었다 — 그래서 네이티브 TTS 엔진을 직접 호출하는 이 플러그인으로 대체한다.
 * 브라우저(웹 폴백)에서는 이 플러그인 자체가 없으므로 js/script.js의 speak()가 기존
 * window.speechSynthesis 경로를 그대로 쓴다.
 */
@CapacitorPlugin(name = "Tts")
public class TtsPlugin extends Plugin {

    private TextToSpeech tts;
    private boolean ready = false;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ready = (status == TextToSpeech.SUCCESS);
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}
            @Override public void onDone(String utteranceId) {}
            @Override public void onError(String utteranceId) {}
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "ko-KR");
        double rate = call.getDouble("rate", 1.0);

        if (!ready || text == null || text.isEmpty()) {
            call.resolve();
            return;
        }

        Locale locale = localeFromBcp47(lang);
        int result = tts.setLanguage(locale);
        // 기기에 해당 언어 TTS 데이터가 없으면(LANG_MISSING_DATA/LANG_NOT_SUPPORTED) 한국어로라도 읽는다 —
        // 아예 무음이 되는 것보다는 낫다.
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            tts.setLanguage(Locale.KOREAN);
        }
        tts.setSpeechRate((float) rate);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ondam-tts-" + System.currentTimeMillis());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void isReady(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", ready);
        call.resolve(result);
    }

    private Locale localeFromBcp47(String bcp47) {
        // "ko-KR" -> Locale("ko","KR"). 언어 부분만 있어도(예: "ko") 동작하게 한다.
        String[] parts = bcp47.split("-");
        if (parts.length >= 2) return new Locale(parts[0], parts[1]);
        return new Locale(parts[0]);
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
    }
}
