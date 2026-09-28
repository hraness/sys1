type Asset = {
  src: `/media/${string}`;
  contentType: string;
  bytes: number | null;
  sha256: string | null;
};

type ImageAsset = Asset & { width: number; height: number; alt: string };

type LaunchMedia = {
  name: string;
  description: string;
  published: string;
  credit: string;
  pages: readonly { file: string; url: string; article: boolean }[];
  poster: ImageAsset;
  social: ImageAsset;
  video: Asset & { width: number; height: number; durationSeconds: number };
  captions: Asset;
  transcript: Asset;
  provenance: { receipt: string; reviewedBy: string | null };
};

// One record owns the visible film's assets and discovery metadata. Fill in
// identities only after the final derivatives have been inspected. --write can
// prepare HTML; --check refuses pending or changed assets before publication.
export const launchMedia: LaunchMedia = {
  name: "Introducing Sys1",
  description: "A 52-second introduction to Sys1: agent review skills, completion checks, and System One decisions with hosted Jev or experimental local models. English captions and a visual transcript accompany the film.",
  published: "2026-09-28T21:17:22Z",
  credit: "Original motion graphics and instrumental score, rendered for Sys1 with Slopcamera.",
  pages: [
    { file: "site/index.html", url: "https://sys1.io/", article: false },
    { file: "site/introducing-sys1.html", url: "https://sys1.io/introducing-sys1", article: true },
  ],
  poster: {
    src: "/media/sys1-launch-poster.jpg", contentType: "image/jpeg", width: 1920, height: 1080,
    alt: "Introducing Sys1: review changes and check completion claims, with the Sys1 mark and sys1.io.",
    bytes: 88241, sha256: "958494b0fbc4cd0c6b4285f65422d3cb6872362c9641c764ef3e35d6d44f8c7c",
  },
  social: {
    src: "/media/sys1-launch-share.jpg", contentType: "image/jpeg", width: 1200, height: 630,
    alt: "Introducing Sys1: review changes and check completion claims, with the Sys1 mark and sys1.io.",
    bytes: 46904, sha256: "2af57ae2e4356d8170209e418a084e7dc00acea9f2e50d7762898669e8aec4e2",
  },
  video: {
    src: "/media/sys1-launch.mp4", contentType: "video/mp4", width: 1920, height: 1080,
    durationSeconds: 52, bytes: 3132193, sha256: "638570d71ff06a9c1609256428e003bf31af10f0d31d11da90f4838ae5dc9438",
  },
  captions: { src: "/media/sys1-launch.vtt", contentType: "text/vtt", bytes: 1008, sha256: "eed082294c8e6a4e4272afa46b8fc0d8d46ed0abedc28ef63e7c2379c11258c8" },
  transcript: { src: "/media/sys1-launch-transcript.txt", contentType: "text/plain", bytes: 2127, sha256: "69d47c4a903f43f56bb9fb53002b0497073826a11aa64c0a32191577c81fb283" },
  provenance: { receipt: "media/sys1-launch/receipts/provenance.json", reviewedBy: "Codex launch-film and integration agents; review scope in receipts/review.json" },
};
