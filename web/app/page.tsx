// The desktop route.
//
// It renders nothing: the desk (components/desktop/Desk.tsx) is drawn by the
// root layout so that it stays put behind every open window — opening the
// Terminal should no more erase the desk than opening an app erases your
// wallpaper. This file exists so `/` resolves and so closing the last window
// has somewhere to land.
export default function Page() {
  return null;
}
