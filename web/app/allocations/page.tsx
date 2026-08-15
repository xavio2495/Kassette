"use client";

import { AppLauncher } from "@/components/desktop/Desktop";

// The route only asks the desktop to open this app; <Desktop/> draws it. Keeping
// the window outside the route is what lets it stay open behind the next one.
export default function Page() {
  return <AppLauncher app="allocations" />;
}
