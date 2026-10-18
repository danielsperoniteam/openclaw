import { createContext } from "solid-js";
import type { ImageLightboxElement } from "./image-lightbox.tsx";

export const ImageLightboxHost = createContext<ImageLightboxElement>();
