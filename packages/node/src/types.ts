/** Node-only types (browser has no filesystem). */

export interface FrameImageOptions {
  outputDir: string;
  format?: 'jpg' | 'png' | 'bmp';
  quality?: number;
  width?: number;
  filenameTemplate?: string;
}

export interface CsvExportOptions {
  header?: boolean;
  delimiter?: string;
}

export interface EdlExportOptions {
  title?: string;
  fcm?: 'DROP FRAME' | 'NON-DROP FRAME';
}
