import { lazy, Loading } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { ImageLightboxHost } from "./image-lightbox-context.ts";
import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";

const Content = lazy(() => import("./image-lightbox-content.tsx"), {
  export: "ImageLightboxContent",
});

export type ImageLightboxProps = {
  connectVideo?: ImageLightboxItem["connectVideo"];
  gallery?: ImageLightboxGallery;
  loadDisplayImage?: ImageLightboxItem["loadDisplayImage"];
  readOriginalBlob?: ImageLightboxItem["readOriginalBlob"];
  mediaKind: "image" | "video";
  src: string;
  originalSrc: string;
  imageTitle: string;
  imageWidth?: number;
  imageHeight?: number;
};

export type ImageLightboxElement = SolidBridgeElement<ImageLightboxProps>;

export const ImageLightbox = defineSolidBridge<ImageLightboxProps>(
  "openclaw-image-lightbox",
  (props, host) => (
    <ImageLightboxHost value={host}>
      <Loading>
        <Content {...props} />
      </Loading>
    </ImageLightboxHost>
  ),
  {
    properties: {
      connectVideo: { default: undefined, attribute: false },
      gallery: { default: undefined, attribute: false },
      loadDisplayImage: { default: undefined, attribute: false },
      readOriginalBlob: { default: undefined, attribute: false },
      mediaKind: { default: "image" },
      src: { default: "" },
      originalSrc: { default: "" },
      imageTitle: { default: "", attribute: false },
      imageWidth: { default: undefined, attribute: false },
      imageHeight: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": ImageLightboxElement;
  }
}
