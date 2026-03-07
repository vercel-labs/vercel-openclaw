import type { ChannelReply, OpenClawContentPart } from "@/server/channels/core/types";

function cleanOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeReplyText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDataImage(
  imageReference: string,
  alt?: string,
): Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }> | null {
  if (!imageReference.toLowerCase().startsWith("data:")) {
    return null;
  }

  const separatorIndex = imageReference.indexOf(",");
  if (separatorIndex <= 5) {
    return null;
  }

  const metadata = imageReference.slice(5, separatorIndex);
  const payload = imageReference.slice(separatorIndex + 1).trim();
  if (payload.length === 0) {
    return null;
  }

  const metadataParts = metadata
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const mimeType = metadataParts.shift() ?? "application/octet-stream";

  let hasBase64Flag = false;
  let filename: string | undefined;
  for (const metadataPart of metadataParts) {
    if (metadataPart.toLowerCase() === "base64") {
      hasBase64Flag = true;
      continue;
    }

    const [key, rawValue] = metadataPart.split("=", 2);
    if (!key || !rawValue) {
      continue;
    }

    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey !== "filename" && normalizedKey !== "name") {
      continue;
    }

    const unquotedValue = rawValue.trim().replace(/^"(.*)"$/u, "$1");
    if (unquotedValue.length === 0) {
      continue;
    }

    try {
      filename = decodeURIComponent(unquotedValue);
    } catch {
      filename = unquotedValue;
    }
  }

  if (!hasBase64Flag) {
    return null;
  }

  const base64 = payload.replace(/\s+/g, "");
  if (base64.length === 0) {
    return null;
  }

  const parsedImage: Extract<NonNullable<ChannelReply["images"]>[number], { kind: "data" }> = {
    kind: "data",
    mimeType,
    base64,
  };
  if (filename) {
    parsedImage.filename = filename;
  }
  const cleanedAltText = cleanOptionalText(alt);
  if (cleanedAltText) {
    parsedImage.alt = cleanedAltText;
  }

  return parsedImage;
}

function toReplyImage(
  imageReference: string,
  alt?: string,
): NonNullable<ChannelReply["images"]>[number] | null {
  const normalizedReference = imageReference.trim();
  if (normalizedReference.length === 0) {
    return null;
  }

  const dataImage = parseDataImage(normalizedReference, alt);
  if (dataImage) {
    return dataImage;
  }

  const urlImage: Extract<NonNullable<ChannelReply["images"]>[number], { kind: "url" }> = {
    kind: "url",
    url: normalizedReference,
  };
  const cleanedAltText = cleanOptionalText(alt);
  if (cleanedAltText) {
    urlImage.alt = cleanedAltText;
  }

  return urlImage;
}

function parseMarkdownImageDestination(destination: string): string {
  const trimmedDestination = destination.trim();
  if (
    trimmedDestination.startsWith("<") &&
    trimmedDestination.endsWith(">") &&
    trimmedDestination.length > 2
  ) {
    return trimmedDestination.slice(1, -1).trim();
  }

  const spacedDestinationMatch =
    /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.exec(trimmedDestination);
  if (spacedDestinationMatch?.[1]) {
    return spacedDestinationMatch[1];
  }

  return trimmedDestination;
}

function extractImagesFromTextContent(content: string): {
  text: string;
  images: NonNullable<ChannelReply["images"]>;
} {
  const images: NonNullable<ChannelReply["images"]> = [];

  let textWithoutMedia = content.replace(
    /^\s*MEDIA:\s*(.+?)\s*$/gim,
    (_match, mediaPath: string) => {
      const parsedImage = toReplyImage(mediaPath);
      if (parsedImage) {
        images.push(parsedImage);
      }
      return "";
    },
  );

  textWithoutMedia = textWithoutMedia.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, altText: string, destination: string) => {
      const imageDestination = parseMarkdownImageDestination(destination);
      const parsedImage = toReplyImage(imageDestination, altText);
      if (parsedImage) {
        images.push(parsedImage);
      }
      return "";
    },
  );

  return {
    text: normalizeReplyText(textWithoutMedia),
    images,
  };
}

function extractContentFromParts(parts: unknown[]): {
  text: string;
  images: NonNullable<ChannelReply["images"]>;
} {
  const textParts: string[] = [];
  const images: NonNullable<ChannelReply["images"]> = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const typedPart = part as Partial<OpenClawContentPart> & {
      text?: unknown;
      image_url?: { url?: unknown };
    };

    if (typedPart.type === "text") {
      if (typeof typedPart.text === "string") {
        textParts.push(typedPart.text);
      }
      continue;
    }

    if (typedPart.type === "image_url") {
      const imageReference = typedPart.image_url?.url;
      if (typeof imageReference === "string") {
        const parsedImage = toReplyImage(imageReference);
        if (parsedImage) {
          images.push(parsedImage);
        }
      }
      continue;
    }

    if (typeof typedPart.text === "string") {
      textParts.push(typedPart.text);
    }
  }

  return {
    text: textParts.join(""),
    images,
  };
}

export function extractReply(responseJson: unknown): ChannelReply | null {
  const content = (
    responseJson as {
      choices?: Array<{ message?: { content?: unknown } }>;
    }
  ).choices?.[0]?.message?.content;

  let extractedText = "";
  let extractedImages: NonNullable<ChannelReply["images"]> = [];

  if (typeof content === "string") {
    extractedText = content;
  } else if (Array.isArray(content)) {
    const fromParts = extractContentFromParts(content);
    extractedText = fromParts.text;
    extractedImages = fromParts.images;
  } else {
    return null;
  }

  const parsedTextContent = extractImagesFromTextContent(extractedText);
  if (parsedTextContent.images.length > 0) {
    extractedImages = extractedImages.concat(parsedTextContent.images);
  }

  if (parsedTextContent.text.length === 0 && extractedImages.length === 0) {
    return null;
  }

  return {
    text: parsedTextContent.text,
    images: extractedImages.length > 0 ? extractedImages : undefined,
  };
}

export function toPlainText(reply: ChannelReply): string {
  const lines: string[] = [];
  if (reply.text.length > 0) {
    lines.push(reply.text);
  }

  for (const image of reply.images ?? []) {
    if (image.kind === "url") {
      lines.push(`Image: ${image.url}`);
    } else {
      lines.push(`Image: [inline ${image.mimeType}]`);
    }
  }

  return lines.join("\n");
}
