import { uploadImageBufferToBunny } from "../lib/bunny-storage";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const receipt = await uploadImageBufferToBunny(
  TRANSPARENT_PNG,
  "image/png",
  {
    folder: "healthchecks/social-image-storage",
    publicId: "bunny-upload-smoke",
  },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      provider: receipt.provider,
      bytes: receipt.bytes,
      checksumSha256: receipt.checksumSha256,
      objectKey: receipt.objectKey,
      storageZone: receipt.storageZone,
      publicUrl: receipt.url,
      verifiedPublicDelivery: true,
    },
    null,
    2,
  ),
);
