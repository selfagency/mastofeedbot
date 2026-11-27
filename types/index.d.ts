export interface Item {
  link: string;
  title: string | undefined;
}

export interface Feed {
  items: Item[];
  title: string;
}
