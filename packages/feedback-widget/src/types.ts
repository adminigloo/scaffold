/** The wire shapes shared with @adminigloo/feedback's submit contract. */

export interface SessionEvent {
  type: "click" | "navigation";
  timestamp: number;
  target?: string;
  value?: string;
}

export interface CapturedError {
  id: string;
  /** `failedRequest`: a fetch/XHR that answered >= 400 or never arrived. */
  type: "error" | "unhandledRejection" | "consoleError" | "failedRequest";
  message: string;
  stack?: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface ClientMetadata {
  browser: string;
  os: string;
  viewport: { width: number; height: number };
  url: string;
  pathname: string;
  clickTrail: SessionEvent[];
  sessionId: string;
  capturedAt: number;
}

export type FeedbackPriority = "low" | "medium" | "high" | "critical";

export interface FeedbackCategoryOption {
  key: string;
  label: string;
  description?: string;
}

export interface ScreenshotData {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

// --- annotations -----------------------------------------------------------

export type AnnotationToolType = "freehand" | "circle" | "arrow" | "text" | "rectangle";

interface BaseAnnotation {
  id: string;
  type: AnnotationToolType;
  color: string;
  strokeWidth: number;
  timestamp: number;
}

export interface FreehandAnnotation extends BaseAnnotation {
  type: "freehand";
  points: { x: number; y: number }[];
}

export interface CircleAnnotation extends BaseAnnotation {
  type: "circle";
  center: { x: number; y: number };
  radiusX: number;
  radiusY: number;
}

export interface ArrowAnnotation extends BaseAnnotation {
  type: "arrow";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TextAnnotation extends BaseAnnotation {
  type: "text";
  position: { x: number; y: number };
  text: string;
  fontSize: number;
}

export interface RectangleAnnotation extends BaseAnnotation {
  type: "rectangle";
  position: { x: number; y: number };
  width: number;
  height: number;
}

export type Annotation =
  | FreehandAnnotation
  | CircleAnnotation
  | ArrowAnnotation
  | TextAnnotation
  | RectangleAnnotation;

// --- configuration ---------------------------------------------------------

export interface FeedbackReporter {
  name?: string;
  email?: string;
}

export interface FeedbackConfig {
  /** Root of the platform's mounted handlers, e.g. "https://platform.example.com/api/igloo". */
  baseUrl: string;
  /**
   * The aik_… website key issued for this install. Optional since 0.4.0: a
   * company's own feedback page (`/api/t/{web address}/feedback`) names the
   * company in its address and needs none.
   */
  clientKey?: string;
  /** Attached to every ticket so triage knows who was in the seat. */
  reporter?: FeedbackReporter;
  /**
   * Take a screenshot of the page when the form opens (default true). Off for
   * a page whose only purpose is the form — a company's public feedback page,
   * where the customer is writing about the business, not about the page they
   * are on — and the form opens straight onto "What happened?" (0.4.0).
   */
  screenshot?: boolean;
  /**
   * Ask for the reporter's name and email in the form (0.4.0), so the team
   * can answer by email as well as under "My reports". Ignored when
   * `reporter` already says who they are. Default false.
   */
  askContact?: boolean;
  /** Register Ctrl+Shift+B (default true). */
  enableShortcut?: boolean;
  /**
   * Extra markers for on-screen overlays to capture and stitch onto the
   * screenshot.
   *
   * `position: fixed` layers (modals and their backdrops, an open AI panel,
   * toasts, a fixed header) are dropped by the full-page capture, so the widget
   * finds every one of them by computed style — whatever library drew it —
   * shoots each separately and composites them back in paint order. Nothing
   * needs configuring for that. These markers are the opt-in path on top
   * (default: dialog roles, `[data-feedback-overlay]`, `[data-chat-panel]`); a
   * marked element must still sit inside a fixed layer. To keep an element out
   * of every screenshot, tag it `data-feedback-ignore`.
   */
  overlaySelectors?: string[];
}
