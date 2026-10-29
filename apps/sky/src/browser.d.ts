interface Window {
  showSaveFilePicker(options?: unknown): Promise<{
    createWritable(): Promise<{
      write(data: string | Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}
interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
