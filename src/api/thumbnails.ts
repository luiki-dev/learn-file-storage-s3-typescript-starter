import { type BunRequest } from "bun";
import { extension } from "mime-types";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import type { ApiConfig } from "../config";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnailFile = formData.get("thumbnail");
  if (!(thumbnailFile instanceof File)) {
    throw new BadRequestError("Invalid thumbnail file");
  }

  // 10 MB
  const MAX_UPLOAD_SIZE = 10 << 20;

  if (thumbnailFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail to large");
  }

  const video = getVideo(cfg.db, videoId);
  if (video?.userID != userID) {
    throw new UserForbiddenError("User is not an owner of the video");
  }

  const mediaType = thumbnailFile.type;
  const fileExtension = extension(mediaType);
  if (!fileExtension) {
    throw new BadRequestError("Invalid thumbnail file type");
  }

  const arrayBuffer: ArrayBuffer = await thumbnailFile.arrayBuffer();

  const filePath = path.join(cfg.assetsRoot, `${videoId}.${fileExtension}`);
  Bun.write(filePath, arrayBuffer);

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${fileExtension}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
