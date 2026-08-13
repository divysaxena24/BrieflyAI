"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircleIcon } from "@/components/dashboard/icons";

interface ToastContextValue {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Show a transient toast message. Must be inside a <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}

/** Mount once per page to provide toast feedback for settings actions. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((message: string) => {
    setToast({ id: Date.now(), message });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className="animate-fade-in-up fixed bottom-6 left-1/2 z-[70] -translate-x-1/2"
        >
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2.5 text-xs font-bold text-zinc-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            <CheckCircleIcon size={14} className="h-3.5 w-3.5 text-emerald-500" />
            {toast.message}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}
