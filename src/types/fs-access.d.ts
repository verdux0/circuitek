// File System Access API bits that lib.dom does not ship (Chromium only, WICG spec).
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemHandle {
  queryPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface Window {
  showDirectoryPicker?(opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string | FileSystemHandle }): Promise<FileSystemDirectoryHandle>;
}
