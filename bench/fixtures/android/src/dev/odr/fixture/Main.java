package dev.odr.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.TextView;

/** Full-screen colour with a tap counter. Each tap shifts the hue so the frame visibly changes. */
public class Main extends Activity {
  private int taps = 0;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    final TextView view = new TextView(this);
    view.setGravity(Gravity.CENTER);
    view.setTextSize(48);
    view.setTextColor(Color.WHITE);
    render(view);
    view.setOnClickListener(v -> { taps += 1; render(view); });
    setContentView(view);
  }

  private void render(TextView view) {
    view.setText("odr fixture\ntaps " + taps);
    view.setBackgroundColor(Color.HSVToColor(new float[] { (taps * 67) % 360, 0.8f, 0.6f }));
  }
}
