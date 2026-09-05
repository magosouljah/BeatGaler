import type { Beat } from "../../types";
import {
  WEB_LIBRARY_FIRST_PAGE_SIZE,
  loadWebLibraryPage,
  type WebLibraryPage,
  type WebLibraryTransport,
} from "./webLibrary";

export interface WebLibraryWindowEvidence {
  pageSize: number;
  totalVisible: number;
  materializedCount: number;
  maxMaterializedCount: number;
  pageLoads: number;
  avoidedRichMaterializations: number;
  richMaterializationRatio: number;
}

export interface WebLibraryWindowSnapshot extends WebLibraryPage {
  previousOffset: number | null;
  evidence: WebLibraryWindowEvidence;
}

export class WebLibraryWindowConsumer {
  private currentPage: WebLibraryPage | null = null;
  private pageLoads = 0;
  private maxMaterializedCount = 0;
  private refreshInFlight: Promise<WebLibraryWindowSnapshot> | null = null;

  constructor(
    private readonly transport: WebLibraryTransport,
    private readonly pageSize = WEB_LIBRARY_FIRST_PAGE_SIZE,
  ) {}

  private snapshot(page: WebLibraryPage): WebLibraryWindowSnapshot {
    this.pageLoads += 1;
    this.maxMaterializedCount = Math.max(this.maxMaterializedCount, page.materializedCount);
    const totalVisible = page.totalVisible;
    return {
      ...page,
      previousOffset: page.offset > 0 ? Math.max(0, page.offset - this.pageSize) : null,
      evidence: {
        pageSize: this.pageSize,
        totalVisible,
        materializedCount: page.materializedCount,
        maxMaterializedCount: this.maxMaterializedCount,
        pageLoads: this.pageLoads,
        avoidedRichMaterializations: Math.max(0, totalVisible - page.materializedCount),
        richMaterializationRatio: totalVisible > 0 ? page.materializedCount / totalVisible : 0,
      },
    };
  }

  private async loadAt(offset: number): Promise<WebLibraryWindowSnapshot> {
    let page = await loadWebLibraryPage(this.transport, { offset, pageSize: this.pageSize });

    // Refresh or direct cursor navigation can point past the last valid page if
    // another device shrank the authoritative library. Rebase to the last valid
    // bounded window instead of exposing a fake empty state.
    if (page.totalVisible > 0 && page.beats.length === 0 && page.offset > 0) {
      const lastOffset = Math.floor((page.totalVisible - 1) / this.pageSize) * this.pageSize;
      page = await loadWebLibraryPage(this.transport, { offset: lastOffset, pageSize: this.pageSize });
    }

    this.currentPage = page;
    return this.snapshot(page);
  }

  async first(): Promise<WebLibraryWindowSnapshot> {
    return this.loadAt(0);
  }

  async at(offset: number): Promise<WebLibraryWindowSnapshot> {
    return this.loadAt(offset);
  }

  async currentOrFirst(): Promise<WebLibraryWindowSnapshot> {
    return this.currentPage ? this.snapshotWithoutLoad(this.currentPage) : this.first();
  }

  async next(): Promise<WebLibraryWindowSnapshot> {
    if (!this.currentPage) return this.first();
    if (this.currentPage.nextOffset === null) return this.snapshotWithoutLoad(this.currentPage);
    return this.loadAt(this.currentPage.nextOffset);
  }

  async previous(): Promise<WebLibraryWindowSnapshot> {
    if (!this.currentPage || this.currentPage.offset <= 0) {
      return this.currentPage ? this.snapshotWithoutLoad(this.currentPage) : this.first();
    }
    return this.loadAt(Math.max(0, this.currentPage.offset - this.pageSize));
  }

  async refresh(): Promise<WebLibraryWindowSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.loadAt(this.currentPage?.offset ?? 0);
    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  private snapshotWithoutLoad(page: WebLibraryPage): WebLibraryWindowSnapshot {
    const totalVisible = page.totalVisible;
    return {
      ...page,
      previousOffset: page.offset > 0 ? Math.max(0, page.offset - this.pageSize) : null,
      evidence: {
        pageSize: this.pageSize,
        totalVisible,
        materializedCount: page.materializedCount,
        maxMaterializedCount: this.maxMaterializedCount,
        pageLoads: this.pageLoads,
        avoidedRichMaterializations: Math.max(0, totalVisible - page.materializedCount),
        richMaterializationRatio: totalVisible > 0 ? page.materializedCount / totalVisible : 0,
      },
    };
  }

  beats(): Beat[] {
    return this.currentPage?.beats.slice() ?? [];
  }
}