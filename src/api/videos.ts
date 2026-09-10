import { respondWithJSON } from "./json";

import { S3Client, type BunRequest } from "bun";
import { randomBytes } from "crypto";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, UserForbiddenError } from "./errors";
import path from "path";
import { extension } from "mime-types";
import { json } from "stream/consumers";

const allowedMediaTypes = ["video/mp4"];

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  // 3 GB
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (video?.userID != userID) {
    throw new UserForbiddenError("User is not an owner of the video");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Invalid thumbnail file");
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video to large");
  }

  const mediaType = videoFile.type;
  if (!allowedMediaTypes.includes(mediaType)) {
    throw new BadRequestError(`Media type: ${mediaType} not allowed`);
  }

  const fileExtension = extension(mediaType);
  if (!fileExtension) {
    throw new BadRequestError("Invalid thumbnail file type");
  }

  const arrayBuffer: ArrayBuffer = await videoFile.arrayBuffer();

  const tempFilePath = path.join(
    cfg.assetsRoot,
    "tmp",
    `${videoId}.${fileExtension}`,
  );
  Bun.write(tempFilePath, arrayBuffer);

  const processedFilePath = await processVideoForFastStart(tempFilePath);

  Bun.file(tempFilePath).delete();

  const aspectRatio = await getVideoAspectRatio(processedFilePath);

  const videoKey = `${aspectRatio}/${videoId}.${fileExtension}`;
  S3Client.file(videoKey).write(Bun.file(processedFilePath), {
    type: mediaType,
  });

  Bun.file(processedFilePath).delete();

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoKey}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    `${filePath}`,
  ]);

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  if ((await proc.exited) != 0) {
    throw new Error(`Error running ffprobe command: ${stderrText}`);
  }

  const stdOutJSON = JSON.parse(stdoutText);
  const width = Number(stdOutJSON.streams[0].width);
  const height = Number(stdOutJSON.streams[0].height);

  switch (Math.floor(width / height)) {
    case Math.floor(16 / 9):
      return "landscape";
    case Math.floor(9 / 16):
      return "portrait";
    default:
      "other";
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);

  const stderrText = await new Response(proc.stderr).text();

  if ((await proc.exited) != 0) {
    throw new Error(`Error running ffmpeg command: ${stderrText}`);
  }

  return outputFilePath;
}
