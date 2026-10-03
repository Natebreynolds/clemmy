import { existsSync } from "node:fs";
import path from "node:path";
import ClementineExperience from "@/components/experience/ClementineExperience";

export default function Home() {
  const hasHeroFilm = ["clem-hero-loop.mp4", "clem-hero-loop.webp"].every((file) =>
    existsSync(path.join(process.cwd(), "public", "media", file)),
  );
  const hasHandoffFilm = existsSync(path.join(process.cwd(), "public", "media", "clem-handoff.mp4"));
  return <ClementineExperience hasHeroFilm={hasHeroFilm} hasHandoffFilm={hasHandoffFilm} />;
}
