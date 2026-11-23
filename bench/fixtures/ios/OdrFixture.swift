import SwiftUI

/// Full-screen colour with a tap counter. Each tap shifts the hue so the frame visibly changes.
@main
struct OdrFixtureApp: App {
  var body: some Scene { WindowGroup { Fixture() } }
}

struct Fixture: View {
  @State private var taps = 0
  var body: some View {
    ZStack {
      Color(hue: Double((taps * 67) % 360) / 360, saturation: 0.8, brightness: 0.6).ignoresSafeArea()
      Text("odr fixture\ntaps \(taps)").font(.system(size: 44, weight: .bold)).foregroundColor(.white)
        .multilineTextAlignment(.center)
    }
    .contentShape(Rectangle())
    .onTapGesture { taps += 1 }
  }
}
