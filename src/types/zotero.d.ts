/**
 * Zotero 9 全局类型声明
 * 提供插件开发中使用的 Zotero、Services、Components 等全局对象的类型提示
 * 这些类型是简化版本，仅覆盖本插件使用的 API
 */

declare const Zotero: {
  initializationPromise: Promise<void>;
  log(msg: string, type?: string): void;
  getMainWindow(): Window | null;

  DataDirectory: {
    dir: string;
  };

  Libraries: {
    userLibraryID: number;
  };

  Collections: {
    getByLibrary(libraryID: number): any[];
    getByParent(collectionID: number): any[];
  };

  Collection: new () => {
    id: number;
    libraryID: number;
    name: string;
    saveTx(): Promise<number | void>;
  };

  CreatorTypes: {
    getName(creatorTypeID: number): string;
  };

  Prefs: {
    get(pref: string, global?: boolean): any;
    set(pref: string, value: any, global?: boolean): void;
  };

  PreferencePanes: {
    register(options: {
      pluginID: string;
      src: string;
      label: string;
    }): string;
  };

  HTTP: {
    request(
      method: string,
      url: string,
      options?: {
        headers?: Record<string, string>;
        responseType?: string;
        body?: string;
      },
    ): Promise<{
      status: number;
      responseText: string;
      response: any;
    }>;
  };

  Search: new () => {
    libraryID: number;
    addCondition(condition: string, operator: string, value: string): void;
    search(): Promise<number[]>;
  };

  Items: {
    get(id: number): any;
  };

  Item: new (itemType: string) => {
    id: number;
    libraryID: number;
    parentID: number;
    setField(field: string, value: string): void;
    getField(field: string): string | number;
    getCreators(): Array<{
      firstName?: string;
      lastName?: string;
      creatorType?: string;
      creatorTypeID?: number;
      fieldMode?: number;
    }>;
    setCreators(
      creators: Array<{
        firstName: string;
        lastName: string;
        creatorType: string;
        fieldMode: number;
      }>,
    ): void;
    addToCollection(collectionID: number): void;
    inCollection?(collectionID: number): boolean;
    getCollections?(): number[];
    getNotes?(): number[];
    setNote(note: string): void;
    getNote?(): string;
    saveTx(): Promise<void>;
  };

  Attachments: {
    importFromFile(options: {
      file: string;
      parentItemID: number;
    }): Promise<any>;
  };

  ProgressWindow: new (options?: { closeOnClick?: boolean }) => {
    changeHeadline(text: string): void;
    show(): void;
    close(): void;
    ItemProgress: new (icon: string, text: string) => {
      setText(text: string): void;
      setProgress(percent: number): void;
    };
  };
};

declare const Services: {
  prompt: {
    alert(win: Window, title: string, message: string): void;
    confirm(win: Window, title: string, message: string): boolean;
    prompt(
      win: Window,
      title: string,
      message: string,
      result: { value: string },
      check: any,
      checkState: any,
    ): boolean;
    select(
      win: Window,
      title: string,
      message: string,
      list: string[],
      selected: { value: number },
    ): boolean;
  };
  io: {
    newURI(spec: string, charset?: string | null, baseURI?: any): any;
  };
  scriptloader: {
    loadSubScript(url: string): void;
  };
};

declare const Components: {
  classes: Record<string, any>;
  interfaces: Record<string, any>;
};

declare const rootURI: string;
declare const APP_SHUTDOWN: number;

declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, data: string): Promise<void>;
  makeDirectory(path: string, options?: { createAncestors?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  getChildren(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type: string; size: number }>;
  move(from: string, to: string): Promise<void>;
};

declare const PathUtils: {
  filename(path: string): string;
  join(...parts: string[]): string;
};

declare const __DEV__: boolean;
