"use client";

import { AppLauncher } from "@/components/desktop/Desktop";

// The route only asks the desktop to open the deck; <Desktop/> draws it.
export default function Page() {
  return <AppLauncher app="pitch" />;
}
