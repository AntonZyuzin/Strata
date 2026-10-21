// fontkit ships no types; the font test only reads the cmap.
declare module 'fontkit' {
  export interface Font {
    familyName: string;
    characterSet: number[];
  }
  export function create(buffer: Uint8Array): Font;
}
