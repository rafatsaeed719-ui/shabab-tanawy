package com.rasoleya.shabab;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Constraints;
import androidx.work.NetworkType;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

/**
 * كل ربع ساعة بيبص على meta/latest في Firestore، ولو فيه رسالة جديدة من قائد الاجتماع بيطلع إشعار.
 * مش محتاج سيرفر، فبيفضل على خطة Firebase المجانية.
 */
public class MessageWorker extends Worker {
    static final String CHANNEL = "messages";
    static final String PREFS = "shabab";
    static final String KEY_SEEN = "lastSeenId";
    private static final String URL_LATEST =
            "https://firestore.googleapis.com/v1/projects/shabab-reda/databases/(default)/documents/meta/latest"
            + "?key=AIzaSyBbwutL7-bHVj0iEbo6Zu8gIJDdyRsEcWI";

    public MessageWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c) {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(MessageWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("messages-check", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    static void createChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "رسائل الاجتماع", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("رسائل قائد الاجتماع");
            c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        try {
            HttpURLConnection con = (HttpURLConnection) new URL(URL_LATEST).openConnection();
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            if (con.getResponseCode() != 200) return Result.success();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject f = new JSONObject(sb.toString()).getJSONObject("fields");
            String id = f.getJSONObject("id").getString("stringValue");
            String preview = f.has("preview") ? f.getJSONObject("preview").optString("stringValue", "") : "";

            SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String seen = sp.getString(KEY_SEEN, null);
            sp.edit().putString(KEY_SEEN, id).apply();
            if (seen == null || seen.equals(id)) return Result.success(); // أول مرة أو مفيش جديد
            notify(c, preview);
        } catch (Exception ignored) { }
        return Result.success();
    }

    static void notify(Context c, String text) {
        if (Build.VERSION.SDK_INT >= 33 &&
                c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        createChannel(c);
        Intent open = new Intent(c, MainActivity.class)
                .putExtra("open", "messages")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("رسالة من قائد الاجتماع")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try { NotificationManagerCompat.from(c).notify(100, b.build()); } catch (SecurityException ignored) { }
    }
}
