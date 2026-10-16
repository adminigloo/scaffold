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
import {
  captureOverlays,
  captureScreenshot,
  isUsableScreenshot,
  stitchOverlays,
  type OverlayShot,
} from "./screenshot.js";
import { parseBrowserInfo, parseOSInfo } from "./recorder.js";
import { useSessionRecorder } from "./useSessionRecorder.js";
import {
  FeedbackTransport,
  type ThreadMessage,
  type ThreadTicket,
} from "./transport.js";
import { loadReports, removeReport, reportsInstallId, saveReport, type StoredReport } from "./reports.js";
import { injectStyles } from "./styles.js";
import type {
  ClientMetadata,
  FeedbackCategoryOption,
  FeedbackConfig,
  FeedbackPriority,
  ScreenshotData,
} from "./types.js";

export type FeedbackStep =
  | "capture"
  | "annotate"
  | "describe"
  | "success"
  | "reports"
  | "thread";

/** The loaded conversation the thread view renders. */
export interface ThreadData {
  ticket: ThreadTicket;
  messages: ThreadMessage[];
}

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
  /**
   * The screenshot is being taken. The open layers are captured BEFORE the
   * modal opens (so the reporter's modal is still there), which can take a
   * moment; the button shows this so the click never looks dead.
   */
  isCapturing: boolean;
  submitError: string | null;
  ticketNumber: string | null;
  /** Reports this browser has sent, newest first — the "My reports" list. */
  reports: StoredReport[];
  /** The report whose thread is open, when step is "thread". */
  activeReport: StoredReport | null;
  thread: ThreadData | null;
  threadLoading: boolean;
  threadError: string | null;
  isReplying: boolean;
  /**
   * The platform's sentence when this form takes no new reports (a closed
   * company, 0.4.0), once its settings have loaded; null when it does. Reading
   * and replying under "My reports" still work.
   */
  closedMessage: string | null;
  /** The form asks for the reporter's name and email (config.askContact, and no config.reporter). */
  askContact: boolean;
  reporterName: string;
  reporterEmail: string;
  setReporterName: (value: string) => void;
  setReporterEmail: (value: string) => void;
  /** The honeypot field's value (0.4.0): rendered off screen, so only a script fills it. */
  website: string;
  setWebsite: (value: string) => void;
  /** Load the form's settings (categories, open or closed) ahead of opening it. Once per mount. */
  prepare: () => Promise<void>;
  openFeedback: () => Promise<void>;
  /** Open the modal straight onto the report list — no screenshot capture. */
  openReports: () => void;
  openThread: (report: StoredReport) => Promise<void>;
  backToReports: () => void;
  /** True when the reply landed; the thread is re-fetched before it returns. */
  sendReply: (body: string) => Promise<boolean>;
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
  // Which "My reports" list is this install's: the website key's, or (no key,
  // a company's own feedback page) the form address's (0.4.0).
  const installId = useMemo(() => reportsInstallId(config), [config.baseUrl, config.clientKey]);
  const askContact = Boolean(config.askContact) && !config.reporter;
  const takeScreenshot = config.screenshot !== false;
  const recorder = useSessionRecorder({ ignoreUrlPrefix: config.baseUrl });

  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<FeedbackStep>("capture");
  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [annotatedDataUrl, setAnnotatedDataUrl] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<FeedbackPriority>("medium");
  const [category, setCategory] = useState("bug");
  const [categories, setCategories] = useState<FeedbackCategoryOption[]>(FALLBACK_CATEGORIES);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState<string | null>(null);
  const [reports, setReports] = useState<StoredReport[]>([]);
  const [activeReport, setActiveReport] = useState<StoredReport | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [isReplying, setIsReplying] = useState(false);
  const [closedMessage, setClosedMessage] = useState<string | null>(null);
  const [reporterName, setReporterName] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [website, setWebsite] = useState("");
  const capturingRef = useRef(false);

  useEffect(() => {
    injectStyles();
    // In an effect, not at render: localStorage does not exist during SSR,
    // and the first client render must match the server's HTML anyway.
    setReports(loadReports(installId));
  }, [installId]);

  // One config fetch per mount, deferred so it never competes with page load.
  const categoriesLoadedRef = useRef(false);
  const loadCategories = useCallback(async () => {
    if (categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true;
    const fetched = await transport.fetchConfig();
    if (fetched.categories && fetched.categories.length > 0) {
      setCategories(fetched.categories);
      // The first of the platform's own list, not "bug": a company's
      // categories may not have one (0.4.0).
      setCategory((current) => (fetched.categories?.some((c) => c.key === current) ? current : (fetched.categories?.[0]?.key ?? current)));
    }
    setClosedMessage(fetched.closed);
  }, [transport]);

  const openFeedback = useCallback(async () => {
    if (capturingRef.current || isOpen) return;
    capturingRef.current = true;
    setIsCapturing(true);
    void loadCategories();

    setStep("capture");
    setScreenshot(null);
    setAnnotatedDataUrl(null);
    setSubmitError(null);
    setTicketNumber(null);

    // A form-only page (config.screenshot false, 0.4.0): nothing on screen
    // is what the report is about, so it opens straight onto the words.
    if (!takeScreenshot) {
      setIsOpen(true);
      setStep("describe");
      capturingRef.current = false;
      setIsCapturing(false);
      return;
    }

    // STEP 1 — capture the reporter's open overlays BEFORE our own UI opens.
    // A `position: fixed` modal, AI panel or toast does not survive a full-page
    // capture (domToCanvas drops fixed positioning), and once our modal is up
    // theirs is covered — so if we waited, the one thing they were looking at
    // would be gone from the shot. We capture them individually now, while
    // they are still on screen, and stitch them back on in step 3.
    let overlays: OverlayShot[] = [];
    try {
      overlays = await captureOverlays(config.overlaySelectors);
    } catch {
      /* an overlay we could not capture is not a reason to fail the report */
    }

    // STEP 2 — now open our modal (with its spinner) and photograph the page.
    // The filter excludes `[data-aif-modal]`, so our own UI never lands in it,
    // and the layers step 1 captured, so none is drawn twice.
    setIsOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const page = await captureScreenshot({
        excludeElements: new Set(overlays.map((overlay) => overlay.element)),
      });
      // STEP 3 — composite the overlays back on at their viewport rects.
      const shot = await stitchOverlays(page, overlays);
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
      setIsCapturing(false);
    }
  }, [isOpen, loadCategories, config.overlaySelectors, takeScreenshot]);

  const closeFeedback = useCallback(() => {
    setIsOpen(false);
    setDescription("");
    setPriority("medium");
    setSubmitError(null);
    setActiveReport(null);
    setThread(null);
    setThreadError(null);
  }, []);

  const openReports = useCallback(() => {
    // No screenshot, no capture guard: this path photographs nothing. A fresh
    // read from storage on every open, so a report sent in another tab is
    // already in the list.
    setReports(loadReports(installId));
    setActiveReport(null);
    setThread(null);
    setThreadError(null);
    setStep("reports");
    setIsOpen(true);
  }, [installId]);

  const openThread = useCallback(
    async (report: StoredReport) => {
      setActiveReport(report);
      setThread(null);
      setThreadError(null);
      setStep("thread");
      setIsOpen(true);
      setThreadLoading(true);
      try {
        const result = await transport.fetchThread(report.ticketNumber, report.token);
        if (result.ok) {
          setThread({ ticket: result.ticket, messages: result.messages });
        } else if (result.gone) {
          // The platform no longer recognises the pair — the ticket was
          // deleted, or this entry belongs to a different install. Keeping a
          // dead row that errors on every tap teaches people the list lies.
          setReports(removeReport(installId, report.ticketNumber));
          setThreadError(
            `Ticket ${report.ticketNumber} is no longer available, so it has been removed from this list.`,
          );
        } else {
          setThreadError(result.error);
        }
      } finally {
        setThreadLoading(false);
      }
    },
    [transport, installId],
  );

  const backToReports = useCallback(() => {
    setActiveReport(null);
    setThread(null);
    setThreadError(null);
    setStep("reports");
  }, []);

  const sendReply = useCallback(
    async (body: string): Promise<boolean> => {
      if (!activeReport || isReplying) return false;
      setIsReplying(true);
      try {
        const result = await transport.sendReply(
          activeReport.ticketNumber,
          activeReport.token,
          body,
        );
        if (!result.ok) {
          setThreadError(result.error);
          return false;
        }
        // Re-fetch rather than append: the server's copy is the conversation,
        // and this also picks up any staff reply that landed meanwhile.
        const refreshed = await transport.fetchThread(
          activeReport.ticketNumber,
          activeReport.token,
        );
        if (refreshed.ok) {
          setThread({ ticket: refreshed.ticket, messages: refreshed.messages });
          setThreadError(null);
        }
        return true;
      } finally {
        setIsReplying(false);
      }
    },
    [activeReport, isReplying, transport],
  );

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
        reporter:
          config.reporter ??
          (askContact && (reporterName.trim() || reporterEmail.trim())
            ? {
                ...(reporterName.trim() ? { name: reporterName.trim().slice(0, 120) } : {}),
                ...(reporterEmail.trim() ? { email: reporterEmail.trim().slice(0, 255) } : {}),
              }
            : undefined),
        clientMetadata: buildClientMetadata(),
        recentErrors: recorder.getErrors(),
        website,
      });

      if (result.ok) {
        setTicketNumber(result.ticketNumber);
        // The follow-up capability, kept where the reporter is: their own
        // browser. Null from a pre-0.4 platform means the report landed and
        // there is simply no thread on offer — the list stays as it was.
        if (result.ticketToken) {
          const title = (description.split("\n", 1)[0] ?? "").slice(0, 100);
          setReports(
            saveReport(installId, {
              ticketNumber: result.ticketNumber,
              title,
              token: result.ticketToken,
              createdAt: Date.now(),
            }),
          );
        }
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
    installId,
    askContact,
    reporterName,
    reporterEmail,
    website,
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
    isCapturing,
    submitError,
    ticketNumber,
    reports,
    activeReport,
    thread,
    threadLoading,
    threadError,
    isReplying,
    closedMessage,
    askContact,
    reporterName,
    reporterEmail,
    setReporterName,
    setReporterEmail,
    website,
    setWebsite,
    prepare: loadCategories,
    openFeedback,
    openReports,
    openThread,
    backToReports,
    sendReply,
    closeFeedback,
    finishAnnotating,
    setDescription,
    setPriority,
    setCategory,
    submit,
  };

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}
