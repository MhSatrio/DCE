// The tracer ships without type declarations: this is the part DCE uses (see src/assets/tools.ts).
declare module 'imagetracerjs' {
  interface TraceImage { width: number; height: number; data: Uint8ClampedArray | number[] }
  const ImageTracer: {
    imagedataToSVG(img: TraceImage, options?: Record<string, unknown>): string;
  };
  export default ImageTracer;
}
