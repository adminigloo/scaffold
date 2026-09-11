import { useCallback, useEffect, useRef, useState } from "react";
import { generateId } from "./recorder.js";
import type { Annotation, AnnotationToolType, TextAnnotation } from "./types.js";

/**
 * Ask Lou's annotation engine, ported intact: two stacked canvases (settled
 * annotations below, live preview above), shape thresholds so a twitch does
 * not become a 2px rectangle, and export by re-rendering everything onto the
 * original screenshot at full resolution.
 */

interface Point {
  x: number;
  y: number;
}

function drawFreehand(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const first = points[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  center: Point,
  radiusX: number,
  radiusY: number,
  color: string,
  width: number,
) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.ellipse(center.x, center.y, Math.abs(radiusX), Math.abs(radiusY), 0, 0, 2 * Math.PI);
  ctx.stroke();
}

function drawRectangle(
  ctx: CanvasRenderingContext2D,
  position: Point,
  w: number,
  h: number,
  color: string,
  width: number,
) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(position.x, position.y, w, h);
}

function drawArrow(ctx: CanvasRenderingContext2D, start: Point, end: Point, color: string, width: number) {
  const headLength = Math.max(width * 3, 15);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 6), end.y - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 6), end.y - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, position: Point, text: string, color: string, fontSize: number) {
  ctx.font = `${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.fillText(text, position.x, position.y);
}

function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation) {
  switch (annotation.type) {
    case "freehand":
      drawFreehand(ctx, annotation.points, annotation.color, annotation.strokeWidth);
      break;
    case "circle":
      drawCircle(ctx, annotation.center, annotation.radiusX, annotation.radiusY, annotation.color, annotation.strokeWidth);
      break;
    case "rectangle":
      drawRectangle(ctx, annotation.position, annotation.width, annotation.height, annotation.color, annotation.strokeWidth);
      break;
    case "arrow":
      drawArrow(ctx, annotation.start, annotation.end, annotation.color, annotation.strokeWidth);
      break;
    case "text":
      drawText(ctx, annotation.position, annotation.text, annotation.color, annotation.fontSize);
      break;
  }
}

interface DrawingState {
  isDrawing: boolean;
  tool: AnnotationToolType;
  startPoint: Point | null;
  currentPoint: Point | null;
  points: Point[];
}

export function useAnnotationCanvas(imageWidth: number, imageHeight: number) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [activeTool, setActiveTool] = useState<AnnotationToolType>("rectangle");
  const [strokeColor, setStrokeColor] = useState("#ff2d2d");
  const [strokeWidth, setStrokeWidth] = useState(4);
  const fontSize = 22;

  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undone, setUndone] = useState<Annotation[]>([]);

  const [textInput, setTextInput] = useState<{ position: Point; value: string } | null>(null);

  const drawingRef = useRef<DrawingState>({
    isDrawing: false,
    tool: "rectangle",
    startPoint: null,
    currentPoint: null,
    points: [],
  });

  /**
   * Pointer coordinates → image space. The canvas element is CSS-scaled to
   * fit the modal, so the ratio is read off the live rect rather than passed
   * in and trusted.
   */
  const toCanvasPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const canvas = overlayRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const annotation of annotations) drawAnnotation(ctx, annotation);
  }, [annotations]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const clearOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const commit = useCallback((annotation: Annotation) => {
    setAnnotations((prev) => [...prev, annotation]);
    setUndone([]);
  }, []);

  const handlePointerDown = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const point = toCanvasPoint(event);
      if (activeTool === "text") {
        setTextInput({ position: point, value: "" });
        return;
      }
      drawingRef.current = {
        isDrawing: true,
        tool: activeTool,
        startPoint: point,
        currentPoint: point,
        points: [point],
      };
    },
    [activeTool, toCanvasPoint],
  );

  const handlePointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const state = drawingRef.current;
      const canvas = overlayRef.current;
      const ctx = canvas?.getContext("2d");
      if (!state.isDrawing || !state.startPoint || !canvas || !ctx) return;
      const point = toCanvasPoint(event);
      state.currentPoint = point;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      switch (state.tool) {
        case "freehand":
          state.points.push(point);
          drawFreehand(ctx, state.points, strokeColor, strokeWidth);
          break;
        case "circle":
          drawCircle(
            ctx,
            {
              x: state.startPoint.x + (point.x - state.startPoint.x) / 2,
              y: state.startPoint.y + (point.y - state.startPoint.y) / 2,
            },
            Math.abs(point.x - state.startPoint.x) / 2,
            Math.abs(point.y - state.startPoint.y) / 2,
            strokeColor,
            strokeWidth,
          );
          break;
        case "rectangle":
          drawRectangle(
            ctx,
            state.startPoint,
            point.x - state.startPoint.x,
            point.y - state.startPoint.y,
            strokeColor,
            strokeWidth,
          );
          break;
        case "arrow":
          drawArrow(ctx, state.startPoint, point, strokeColor, strokeWidth);
          break;
      }
    },
    [strokeColor, strokeWidth, toCanvasPoint],
  );

  const handlePointerUp = useCallback(() => {
    const state = drawingRef.current;
    if (!state.isDrawing || !state.startPoint || !state.currentPoint) {
      state.isDrawing = false;
      return;
    }
    const base = { id: generateId("ann"), color: strokeColor, strokeWidth, timestamp: Date.now() };
    const { startPoint, currentPoint } = state;
    let annotation: Annotation | null = null;

    switch (state.tool) {
      case "freehand":
        if (state.points.length >= 2) annotation = { ...base, type: "freehand", points: [...state.points] };
        break;
      case "circle": {
        const radiusX = Math.abs(currentPoint.x - startPoint.x) / 2;
        const radiusY = Math.abs(currentPoint.y - startPoint.y) / 2;
        if (radiusX > 5 || radiusY > 5) {
          annotation = {
            ...base,
            type: "circle",
            center: {
              x: startPoint.x + (currentPoint.x - startPoint.x) / 2,
              y: startPoint.y + (currentPoint.y - startPoint.y) / 2,
            },
            radiusX,
            radiusY,
          };
        }
        break;
      }
      case "rectangle": {
        const width = currentPoint.x - startPoint.x;
        const height = currentPoint.y - startPoint.y;
        if (Math.abs(width) > 5 || Math.abs(height) > 5) {
          annotation = {
            ...base,
            type: "rectangle",
            position: {
              x: width >= 0 ? startPoint.x : currentPoint.x,
              y: height >= 0 ? startPoint.y : currentPoint.y,
            },
            width: Math.abs(width),
            height: Math.abs(height),
          };
        }
        break;
      }
      case "arrow": {
        const dx = currentPoint.x - startPoint.x;
        const dy = currentPoint.y - startPoint.y;
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
          annotation = { ...base, type: "arrow", start: { ...startPoint }, end: { ...currentPoint } };
        }
        break;
      }
    }

    if (annotation) commit(annotation);
    drawingRef.current = { isDrawing: false, tool: state.tool, startPoint: null, currentPoint: null, points: [] };
    clearOverlay();
  }, [strokeColor, strokeWidth, commit, clearOverlay]);

  const submitText = useCallback(() => {
    if (textInput && textInput.value.trim()) {
      const annotation: TextAnnotation = {
        id: generateId("ann"),
        type: "text",
        color: strokeColor,
        strokeWidth,
        fontSize,
        position: textInput.position,
        text: textInput.value.trim(),
        timestamp: Date.now(),
      };
      commit(annotation);
    }
    setTextInput(null);
  }, [textInput, strokeColor, strokeWidth, commit]);

  const undo = useCallback(() => {
    setAnnotations((prev) => {
      const last = prev[prev.length - 1];
      if (last) setUndone((u) => [...u, last]);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setUndone((prev) => {
      const last = prev[prev.length - 1];
      if (last) setAnnotations((a) => [...a, last]);
      return prev.slice(0, -1);
    });
  }, []);

  const clearAll = useCallback(() => {
    setAnnotations([]);
    setUndone([]);
    clearOverlay();
  }, [clearOverlay]);

  /** Screenshot + annotations at native resolution, as JPEG. */
  const renderAnnotated = useCallback(
    (imageDataUrl: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = imageWidth;
          canvas.height = imageHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("no canvas context"));
            return;
          }
          ctx.drawImage(img, 0, 0, imageWidth, imageHeight);
          for (const annotation of annotations) drawAnnotation(ctx, annotation);
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        };
        img.onerror = () => reject(new Error("screenshot image failed to load"));
        img.src = imageDataUrl;
      }),
    [imageWidth, imageHeight, annotations],
  );

  return {
    canvasRef,
    overlayRef,
    activeTool,
    setActiveTool,
    strokeColor,
    setStrokeColor,
    strokeWidth,
    setStrokeWidth,
    annotations,
    canUndo: annotations.length > 0,
    canRedo: undone.length > 0,
    undo,
    redo,
    clearAll,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    textInput,
    setTextInput,
    submitText,
    renderAnnotated,
  };
}
