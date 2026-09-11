/** The wire shapes shared with @adminigloo/feedback's submit contract. */

export interface SessionEvent {
  type: "click" | "navigation";
  timestamp: number;
  target?: string;
  value?: string;
}

export interface CapturedError {
  id: string;
  type: "error" | "unhandledRejection" | "consoleError";
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
  /** The aik_… license key issued for this install. */
  clientKey: string;
  /** Attached to every ticket so triage knows who was in the seat. */
  reporter?: FeedbackReporter;
  /** Register Ctrl+Shift+B (default true). */
  enableShortcut?: boolean;
}
