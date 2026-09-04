declare module "__beatgaler_mtcute_authorization__" {
  export const doAuthorization: (...args: any[]) => Promise<[Uint8Array, any, number]>;
}

declare module "__beatgaler_mtcute_utils__" {
  export const TlBinaryWriter: any;
  export const TlSerializationCounter: any;
  export const __tlReaderMap: any;
  export const __tlWriterMap: any;
  export const longFromBuffer: (value: Uint8Array) => any;
  export const randomLong: () => any;
}
