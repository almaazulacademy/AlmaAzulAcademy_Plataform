import Image from "next/image";

type Props = {
  src: string;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

export function EditorialImage({ src, alt, className, sizes = "100vw", priority = false }: Props) {
  if (/^https:\/\//i.test(src)) {
    // HTTPS editorial URLs are validated server-side. Native img allows approved hosts without widening next/image globally.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className={className} loading={priority ? "eager" : "lazy"} />;
  }
  return <Image src={src} alt={alt} fill priority={priority} sizes={sizes} className={className} />;
}
