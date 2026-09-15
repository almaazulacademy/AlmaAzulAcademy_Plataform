"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type Props = {
  /** Versão para telas a partir de 768px. */
  desktopSrc: string;
  /** Versão leve para celular. */
  mobileSrc: string;
  /**
   * Poster nativo do elemento. O navegador baixa o poster na hora, mesmo fora da
   * tela: use só com arquivo leve. Para vídeo abaixo da dobra, deixe o
   * `fallback` (next/image lazy) fazer esse papel.
   */
  poster?: string;
  /**
   * Conteúdo estático renderizado pelo servidor (normalmente um next/image).
   * Ocupa o espaço desde o primeiro paint, então o vídeo entra sem CLS.
   */
  fallback: ReactNode;
  /**
   * `until-playing`: o estático aparece até o vídeo começar (vídeo de ambiente).
   * `on-failure`: o estático só aparece se o vídeo não puder tocar — para
   * animações cujo primeiro quadro é vazio, como a do logo.
   */
  fallbackMode?: "until-playing" | "on-failure";
  loop?: boolean;
  /** Só baixa o vídeo quando a seção se aproxima da tela. */
  lazy?: boolean;
  className?: string;
};

type Mode = "idle" | "video" | "static" | "ended";

/**
 * Vídeo decorativo: sem som, sem controles, autoplay inline.
 *
 * - `prefers-reduced-motion: reduce` → nunca baixa nem toca o vídeo; fica a imagem.
 * - Economia de dados (`saveData`) → mesma coisa.
 * - Erro de carregamento ou autoplay bloqueado → volta para a imagem.
 * - Sem `loop`, ao terminar o vídeo dá lugar ao estático (o quadro final), que
 *   permanece — alguns navegadores não mantêm o último quadro pintado.
 */
export function AmbientVideo({ desktopSrc, mobileSrc, poster, fallback, fallbackMode = "until-playing", loop = false, lazy = false, className }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (reduced.matches || saveData) {
      setMode("static");
      return;
    }

    const choose = () => setSrc(window.matchMedia("(min-width: 768px)").matches ? desktopSrc : mobileSrc);
    const onMotionChange = () => {
      if (reduced.matches) {
        video.pause();
        setMode("static");
      }
    };
    reduced.addEventListener("change", onMotionChange);

    if (!lazy || !("IntersectionObserver" in window)) {
      choose();
      return () => reduced.removeEventListener("change", onMotionChange);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          choose();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", onMotionChange);
    };
  }, [desktopSrc, mobileSrc, lazy]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || mode === "static" || mode === "ended") return;
    video.muted = true;
    const play = () => {
      if (document.hidden || video.ended || !video.paused) return;
      // NotAllowedError = autoplay bloqueado de fato. AbortError acontece quando a
      // aba está em segundo plano: tenta de novo quando ela voltar a ficar visível.
      video.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") setMode("static");
      });
    };
    play();
    document.addEventListener("visibilitychange", play);
    // Autoplay bloqueado sem erro (ex.: modo de pouca energia do iOS): não fica vazio.
    // Vídeo ainda baixando não está pausado, então não cai no estático por lentidão.
    const timeout = window.setTimeout(() => {
      if (!document.hidden && video.paused && !video.ended) setMode((current) => (current === "video" ? current : "static"));
    }, 4000);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", play);
    };
  }, [src, mode]);

  const showFallback = mode === "static" || mode === "ended" || (fallbackMode === "until-playing" && mode !== "video");

  return (
    <>
      <div aria-hidden={mode !== "static"} className={cn("absolute inset-0 transition-opacity duration-700", showFallback ? "opacity-100" : "opacity-0")}>
        {fallback}
      </div>
      <video
      ref={ref}
      src={src ?? undefined}
      poster={poster}
      muted
      playsInline
      autoPlay
      loop={loop}
      preload={src ? "auto" : "none"}
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      onPlaying={() => setMode((current) => (current === "static" ? current : "video"))}
      onEnded={() => setMode("ended")}
      onError={() => setMode("static")}
      className={cn("absolute inset-0 h-full w-full transition-opacity duration-700", mode === "video" ? "opacity-100" : "opacity-0", className)}
      data-state={mode}
      />
    </>
  );
}
