import { useCallback, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { useAnnotationCanvas } from "./useAnnotationCanvas.js";
import {
  IconArrow,
  IconCircle,
  IconPencil,
  IconRedo,
  IconSquare,
  IconTrash,
  IconType,
  IconUndo,
} from "./icons.js";
import type { AnnotationToolType, ScreenshotData } from "./types.js";

const TOOLS: Array<{ tool: AnnotationToolType; label: string; icon: ReactElement }> = [
  { tool: "rectangle", label: "Rectangle", icon: <IconSquare /> },
  { tool: "circle", label: "Circle", icon: <IconCircle /> },
  { tool: "arrow", label: "Arrow", icon: <IconArrow /> },
  { tool: "freehand", label: "Draw", icon: <IconPencil /> },
  { tool: "text", label: "Text", icon: <IconType /> },
];

const COLORS = ["#ff2d2d", "#ff8a00", "#ffd400", "#12b23b", "#1f6fff", "#8b3dff", "#000000", "#ffffff"];

export function AnnotationStage({
  screenshot,
  onDone,
  onSkip,
}: {
  screenshot: ScreenshotData;
  /** annotated JPEG data URL, or null when nothing was drawn */
  onDone: (annotated: string | null) => void;
  onSkip: () => void;
}) {
  const annotation = useAnnotationCanvas(screenshot.width, screenshot.height);

  const handleDone = useCallback(async () => {
    if (annotation.annotations.length === 0) {
      onDone(null);
      return;
    }
    try {
      onDone(await annotation.renderAnnotated(screenshot.dataUrl));
    } catch {
      // A failed render loses the markup, not the report.
      onDone(null);
    }
  }, [annotation, screenshot.dataUrl, onDone]);

  const pointer = {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      annotation.handlePointerDown(event);
    },
    onPointerMove: annotation.handlePointerMove,
    onPointerUp: annotation.handlePointerUp,
    onPointerCancel: annotation.handlePointerUp,
  };

  return (
    <div>
      <div className="aif-toolbar" role="toolbar" aria-label="Annotation tools">
        <div className="aif-toolbar-group">
          {TOOLS.map(({ tool, label, icon }) => (
            <button
              key={tool}
              type="button"
              title={label}
              aria-label={label}
              className={`aif-icon-btn${annotation.activeTool === tool ? " aif-active" : ""}`}
              onClick={() => annotation.setActiveTool(tool)}
            >
              {icon}
            </button>
          ))}
        </div>
        <div className="aif-toolbar-sep" />
        <div className="aif-toolbar-group">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              className={`aif-swatch${annotation.strokeColor === color ? " aif-active" : ""}`}
              style={{ background: color }}
              onClick={() => annotation.setStrokeColor(color)}
            />
          ))}
        </div>
        <div className="aif-toolbar-sep" />
        <div className="aif-toolbar-group">
          <select
            className="aif-width-select"
            aria-label="Stroke width"
            value={annotation.strokeWidth}
            onChange={(event) => annotation.setStrokeWidth(Number(event.target.value))}
          >
            <option value={2}>Thin</option>
            <option value={4}>Medium</option>
            <option value={6}>Thick</option>
            <option value={10}>Extra thick</option>
          </select>
        </div>
        <div className="aif-toolbar-sep" />
        <div className="aif-toolbar-group">
          <button
            type="button"
            className="aif-icon-btn"
            title="Undo"
            aria-label="Undo"
            disabled={!annotation.canUndo}
            onClick={annotation.undo}
          >
            <IconUndo />
          </button>
          <button
            type="button"
            className="aif-icon-btn"
            title="Redo"
            aria-label="Redo"
            disabled={!annotation.canRedo}
            onClick={annotation.redo}
          >
            <IconRedo />
          </button>
          <button
            type="button"
            className="aif-icon-btn"
            title="Clear all"
            aria-label="Clear all annotations"
            disabled={!annotation.canUndo}
            onClick={annotation.clearAll}
          >
            <IconTrash />
          </button>
        </div>
      </div>

      <div className="aif-stage-wrap">
        <div className="aif-stage">
          <img src={screenshot.dataUrl} alt="Screenshot to annotate" draggable={false} />
          <canvas ref={annotation.canvasRef} width={screenshot.width} height={screenshot.height} />
          <canvas
            ref={annotation.overlayRef}
            className="aif-draw-layer"
            width={screenshot.width}
            height={screenshot.height}
            {...pointer}
          />
          {annotation.textInput ? (
            <input
              className="aif-text-input"
              style={{
                left: `${(annotation.textInput.position.x / screenshot.width) * 100}%`,
                top: `${(annotation.textInput.position.y / screenshot.height) * 100}%`,
              }}
              autoFocus
              value={annotation.textInput.value}
              placeholder="Type, then Enter"
              onChange={(event) =>
                annotation.setTextInput((prev) => (prev ? { ...prev, value: event.target.value } : prev))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") annotation.submitText();
                if (event.key === "Escape") annotation.setTextInput(null);
              }}
              onBlur={annotation.submitText}
            />
          ) : null}
        </div>
      </div>
      <p className="aif-hint">Mark what went wrong — draw on the screenshot, then continue.</p>

      <div className="aif-modal-footer" style={{ padding: "14px 0 0", borderTop: "none" }}>
        <button type="button" className="aif-btn aif-btn-ghost" onClick={onSkip}>
          Skip annotation
        </button>
        <button type="button" className="aif-btn aif-btn-primary" onClick={() => void handleDone()}>
          Continue
        </button>
      </div>
    </div>
  );
}
