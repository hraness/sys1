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
  description: "A 34-second introduction to Sys1: a coding agent's completion claim, each claim checked against Git, pull requests and live pages, the compact-output skill, and how to ask your agent to install Sys1. English captions and a visual transcript accompany the film.",
  published: "2026-10-04T16:50:18Z",
  credit: "Original motion graphics, rendered for Sys1 with the Hraness story-film engine.",
  pages: [
    { file: "site/index.html", url: "https://sys1.io/", article: false },
    { file: "site/introducing-sys1.html", url: "https://sys1.io/introducing-sys1", article: true },
  ],
  poster: {
    src: "/media/sys1-launch-poster.jpg", contentType: "image/jpeg", width: 1920, height: 1080,
    alt: "Introducing Sys1: review changes and check completion claims, with the Sys1 mark and sys1.io.",
    bytes: 151575, sha256: "a95ae87f002a0c0a9dffc340b008f123604e5809d166f029753781a8971e9cf1",
  },
  social: {
    src: "/media/sys1-launch-share.jpg", contentType: "image/jpeg", width: 1200, height: 630,
    alt: "Introducing Sys1: review changes and check completion claims, with the Sys1 mark and sys1.io.",
    bytes: 77617, sha256: "51dd1c458eea2e08862b56a3d211cf7ff2b9f9b5893f677a408fcf722fd86c41",
  },
  video: {
    src: "/media/sys1-launch.mp4", contentType: "video/mp4", width: 1920, height: 1080,
    durationSeconds: 34, bytes: 4793597, sha256: "d48cc625843a2774c9a3ab1ce136f98101acc0d4560b2317703a1ca453276933",
  },
  captions: { src: "/media/sys1-launch.vtt", contentType: "text/vtt", bytes: 755, sha256: "dc41e03282a5ed479f853e5dafbc42cd5eab5b0be97958b327468d5925c7efcb" },
  transcript: { src: "/media/sys1-launch-transcript.txt", contentType: "text/plain", bytes: 718, sha256: "b7b03ece95f3fd53d710f75e7b7ef3678805d74fc5b0cdab18a5a4d0b9fdb416" },
  provenance: { receipt: "media/sys1-launch/receipts/provenance.json", reviewedBy: "Devin launch-film agent: contact-sheet review of every act and the delivered frames; not an independent review. Scope in receipts/review.json" },
};
