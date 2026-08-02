"use client";

import { useEffect, useState } from "react";

function remainingSeconds(expiresAt: string) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const [seconds, setSeconds] = useState(() => remainingSeconds(expiresAt));

  useEffect(() => {
    const update = () => {
      const next = remainingSeconds(expiresAt);
      setSeconds(next);
      if (next === 0) onExpire?.();
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, onExpire]);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return (
    <time dateTime={expiresAt} className="font-mono text-4xl font-semibold tracking-[-0.04em] sm:text-5xl" aria-live="polite">
      {[hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":")}
    </time>
  );
}
