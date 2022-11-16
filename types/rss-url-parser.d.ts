declare module 'rss-url-parser' {
  type Type = "atom" | "rss" | "rdf";

  interface NS {
    [key: string]: string;
  }

  interface Image {
    url: string;
    title: string;
  }

  interface Meta {
    "#ns": NS[];
    "#type": Type;
    "#version": string;
    title: string;
    description: string;
    date: Date | null;
    pubdate: Date | null;
    link: string;
    xmlurl: string;
    author: string;
    language: string;
    image: Image;
    favicon: string;
    copyright: string;
    generator: string;
    categories: string[];
  }

  interface Enclosure {
    length?: string | undefined;
    type?: string | undefined;
    url: string;
  }

  interface Item {
    title: string;
    description: string;
    summary: string;
    date: Date | null;
    pubdate: Date | null;
    link: string;
    origlink: string;
    author: string;
    guid: string;
    comments: string;
    image: Image;
    categories: string[];
    enclosures: Enclosure[];
    meta: Meta;
  }

  export default function parser(url: string): Promise<Item[]>;
}
