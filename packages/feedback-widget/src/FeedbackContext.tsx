import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { captureScreenshot, isUsableScreenshot } from "./screenshot.js";
import { parseBrowserInfo, parseOSInfo } from "./recorder.js";
import { useSessionRecorder } from "./useSessionRecorder.js";
import { FeedbackTransport } from "./transport.js";
import { injectStyles } from "./styles.js";
import type {
  ClientMetadata,
  FeedbackCategoryOption,
  FeedbackConfig,
  FeedbackPriority,
  ScreenshotData,
} from "./types.js";

export type FeedbackStep = "capture" | "annotate" | "describe" | "success";

/** Shown until (and in case) the platform's /v1/config is unreachable. */
const FALLBACK_CATEGORIES: FeedbackCategoryOption[] = [
  { key: "bug", label: "Bug report" },
  { key: "feature_request", label: "Feature request" },
  { key: "question", label: "Question" },
  { key: "other", label: "Other" },
];

export interface FeedbackContextValue {
  isOpen: boolean;
  step: FeedbackStep;
  screenshot: ScreenshotData | null;
  annotatedDataUrl: string | null;
  description: string;
  priority: FeedbackPriority;
  category: string;
  categories: FeedbackCategoryOption[];
  isSubmitting: boolean;
  submitError: string | null;
  ticketNumber: string | null;
  openFeedback: () => Promise<void>;
  closeFeedback: () => void;
  finishAnnotating: (annotatedDataUrl: string | null) => void;
  setDescription: (value: string) => void;
  setPriority: (value: FeedbackPriority) => void;
  setCategory: (value: string) => void;
  submit: () => Promise<void>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function useFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return value;
}

export function FeedbackProvider({
  config,
  children,
}: {
  config: FeedbackConfig;
  children?: ReactNode;
}) {
  const transport = useMemo(
    () => new FeedbackTransport(config.baseUrl, config.clientKey),
    [config.baseUrl, config.clientKey],
  );
  const recorder = useSessionRecorder();

  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<FeedbackStep>("capture");
  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [annotatedDataUrl, setAnnotatedDataUrl] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<FeedbackPriority>("medium");
  const [category, setCategory] = useState("bug");
  const [categories, setCategories] = useState<FeedbackCategoryOption[]>(FALLBACK_CATEGORIES);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState<string | null>(null);
  const capturingRef = useRef(false);

  useEffect(() => {
    injectStyles();
  }, []);

  // One config fetch per mount, deferred so it never competes with page load.
  const categoriesLoadedRef = useRef(false);
  const loadCategories = useCallback(async () => {
    if (categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true;
    const fetched = await transport.fetchCategories();
    if (fetched && fetched.length > 0) setCategories(fetched);
  }, [transport]);

  const openFeedback = useCallback(async () => {
    if (capturingRef.current || isOpen) return;
    capturingRef.current = true;
    void loadCategories();

    setStep("capture");
    setScreenshot(null);
    setAnnotatedDataUrl(null);
    setSubmitError(null);
    setTicketNumber(null);
    setIsOpen(true);

    // Give the modal a frame to mount so the capture filter can exclude it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const shot = await captureScreenshot();
      if (isUsableScreenshot(shot.dataUrl)) {
        setScreenshot(shot);
        setStep("annotate");
      } else {
        setStep("describe");
      }
    } catch {
      // No screenshot is a degraded report, not a failed one.
      setStep("describe");
    } finally {
      capturingRef.current = false;
    }
  }, [isOpen, loadCategories]);

  const closeFeedback = useCallback(() => {
    setIsOpen(false);
    setDescription("");
    setPriority("medium");
    setSubmitError(null);
  }, []);

  const finishAnnotating = useCallback((annotated: string | null) => {
    setAnnotatedDataUrl(annotated);
    setStep("describe");
  }, []);

  const buildClientMetadata = useCallback((): ClientMetadata => {
    return {
      browser: parseBrowserInfo(navigator.userAgent),
      os: parseOSInfo(navigator.userAgent),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      url: window.location.href.slice(0, 2000),
      pathname: window.location.pathname.slice(0, 500),
      clickTrail: recorder.getEvents(),
      sessionId: recorder.getSessionId(),
      capturedAt: Date.now(),
    };
  }, [recorder]);

  const submit = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Upload failures degrade to a report without images — never a blocked submit.
      const screenshotUrl = screenshot
        ? ((await transport.uploadScreenshot(screenshot.dataUrl, "screenshot")) ?? undefined)
        : undefined;
      const annotatedUrl = annotatedDataUrl
        ? ((await transport.uploadScreenshot(annotatedDataUrl, "annotated")) ?? undefined)
        : undefined;

      const result = await transport.submit({
        description,
        priority,
        category,
        screenshotUrl,
        annotatedScreenshotUrl: annotatedUrl,
        reporter: config.reporter,
        clientMetadata: buildClientMetadata(),
        recentErrors: recorder.getErrors(),
      });

      if (result.ok) {
        setTicketNumber(result.ticketNumber);
        setStep("success");
      } else {
        setSubmitError(result.error);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    screenshot,
    annotatedDataUrl,
    description,
    priority,
    category,
    config.reporter,
    transport,
    recorder,
    buildClientMetadata,
  ]);

  // Ctrl+Shift+B, the muscle-memory trigger.
  const enableShortcut = config.enableShortcut ?? true;
  useEffect(() => {
    if (!enableShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        void openFeedback();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enableShortcut, openFeedback]);

  const value: FeedbackContextValue = {
    isOpen,
    step,
    screenshot,
    annotatedDataUrl,
    description,
    priority,
    category,
    categories,
    isSubmitting,
    submitError,
    ticketNumber,
    openFeedback,
    closeFeedback,
    finishAnnotating,
    setDescription,
    setPriority,
    setCategory,
    submit,
  };

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}
