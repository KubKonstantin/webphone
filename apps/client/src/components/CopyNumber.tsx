import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyNumber({ number }: { number: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(number);
      setState("copied");
    } catch {
      setState("error");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2500);
  };
  const label = state === "copied" ? "Номер скопирован" : state === "error" ? "Не удалось скопировать номер" : `Копировать ${number}`;
  return (
    <span className="copy-number">
      <button type="button" className="copy-button" title={label} aria-label={label} onClick={() => void copy()}>
        {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <span className={state === "error" ? "copy-error" : "sr-only"} role="status">{state === "idle" ? "" : label}</span>
    </span>
  );
}
