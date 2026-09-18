"use client";

import { useEffect } from "react";

/**
 * Register the service worker.
 *
 * Its only jobs are making the app installable on Android and showing an
 * honest "no signal" card instead of the browser's error page — see the worker
 * itself. Failure here is not worth surfacing: the app works fine without it,
 * and a driver does not need a toast about a worker.
 */
export function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/delivery/sw.js", { scope: "/delivery" }).catch((err) => {
      console.warn("[delivery] service worker registration failed:", err);
    });
  }, []);
  return null;
}
