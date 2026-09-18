"use client";

import { useEffect, useRef, useState } from "react";
import { CameraOff, X } from "lucide-react";

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = new (options: { formats: string[] }) => Detector;

function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "O acesso à câmera foi negado. Libere a câmera para este site nas configurações do navegador e tente de novo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhuma câmera foi encontrada neste aparelho.";
  if (name === "NotReadableError") return "A câmera está em uso por outro aplicativo. Feche-o e tente de novo.";
  return "Não foi possível abrir a câmera. Use o check-in manual na lista.";
}

/**
 * Leitor de QR dentro do próprio painel.
 *
 * Usa o `BarcodeDetector` nativo quando existe (Chrome/Android) e cai para o
 * `jsQR` — carregado só quando necessário — no Safari/iOS. A câmera traseira é
 * pedida por padrão. Ao ler, a câmera é desligada e o texto sobe para quem
 * chamou; nada aqui registra presença.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement("canvas");
    const context2d = canvas.getContext("2d", { willReadFrequently: true });

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("A câmera só funciona em conexão segura (https). Use o check-in manual na lista.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (failure) {
        setError(cameraErrorMessage(failure));
        return;
      }
      if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setReady(true);

      const NativeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
      let detector: Detector | null = null;
      if (NativeDetector) {
        try { detector = new NativeDetector({ formats: ["qr_code"] }); } catch { detector = null; }
      }
      let jsQR: typeof import("jsqr").default | null = detector ? null : (await import("jsqr")).default;
      let detectorFailures = 0;

      const tick = async () => {
        if (stopped) return;
        let text: string | null = null;
        if (video.readyState >= 2 && video.videoWidth) {
          if (detector) {
            try {
              const codes = await detector.detect(video);
              text = codes[0]?.rawValue ?? null;
            } catch {
              // Detector nativo instável em alguns aparelhos: cai para o jsQR.
              detectorFailures += 1;
              if (detectorFailures >= 3) {
                detector = null;
                jsQR = (await import("jsqr")).default;
              }
            }
          } else if (jsQR && context2d) {
            try {
              const scale = Math.min(1, 720 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
              const image = context2d.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
            } catch {
              text = null;
            }
          }
        }
        if (stopped) return;
        if (text) {
          stop();
          navigator.vibrate?.(60);
          onResultRef.current(text);
          return;
        }
        timer = setTimeout(tick, 150);
      };
      tick();
    };

    start();
    return stop;
  }, []);

  return (
    <div className="fixed inset-0 z-[95] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Escanear QR Code">
      <div className="flex items-center justify-between px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] text-white">
        <p className="text-base font-semibold">Aponte para o QR Code</p>
        <button type="button" onClick={onClose} className="grid size-12 place-items-center rounded-full bg-white/15 hover:bg-white/25" aria-label="Fechar câmera">
          <X className="size-6" />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted />
        {!error ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="aspect-square w-[70vw] max-w-[320px] rounded-3xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>
        ) : null}
        {!ready && !error ? <p className="absolute inset-x-0 bottom-10 text-center text-sm text-white/80">Abrindo a câmera…</p> : null}
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm rounded-3xl bg-white p-6 text-center">
              <CameraOff className="mx-auto size-8 text-red-700" />
              <p className="mt-4 text-base leading-6 text-ink" role="alert">{error}</p>
              <button type="button" onClick={onClose} className="mt-5 h-12 w-full rounded-full bg-ink text-base font-semibold text-white">Voltar à lista</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
