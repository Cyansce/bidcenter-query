import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { followUp, normalizeDetail, normalizeSearch } from '../bidcenter/parser';
import { SearchItem } from '../bidcenter/protocol';
import { ProjectQueryDto } from '../common/dto';
import { Prisma } from '../generated/prisma/client';

@Injectable()
export class ProjectsService {
  constructor(private readonly db: DbService) {}
  async saveListing(item: SearchItem, query: string) {
    const value = normalizeSearch(item, query);
    return this.db.$transaction(async tx => {
      const project = await tx.project.upsert({ where: { sourceId: value.sourceId }, create: value, update: {
        lastSeenAt: new Date(), listingDataJson: value.listingDataJson, originalUrl: value.originalUrl || undefined,
        listedDeadlineRaw: value.listedDeadlineRaw, expectedPurchaseRaw: value.expectedPurchaseRaw,
      } });
      await tx.queryMatch.upsert({ where: { projectId_query: { projectId: project.id, query } }, create: { projectId: project.id, query }, update: { lastSeenAt: new Date() } });
      return project;
    });
  }
  async saveDetail(sourceId: string, detail: Record<string, any>, fallback: ReturnType<typeof normalizeSearch>) {
    const value = normalizeDetail(sourceId, detail, fallback);
    await this.db.$transaction(async tx => {
      const previous = await tx.project.findUniqueOrThrow({ where: { sourceId } });
      // A later restricted response must not destroy a previously saved full member copy.
      const data = previous.accessLevel === 'FULL' && value.accessLevel !== 'FULL'
        ? { detailStatus: 'RESTRICTED', detailError: '本次详情权限受限；保留此前已保存的完整会员内容' } : value;
      const project = await tx.project.update({ where: { sourceId }, data });
      await tx.projectRevision.upsert({
        where: { projectId_hash: { projectId: project.id, hash: value.contentHash } },
        create: { projectId: project.id, hash: value.contentHash, snapshotJson: JSON.stringify(value) }, update: {},
      });
    });
    return value;
  }
  async list(query: ProjectQueryDto) {
    const where: Prisma.ProjectWhereInput = {};
    if (query.keyword) where.OR = [{ title: { contains: query.keyword } }, { bodyText: { contains: query.keyword } }];
    if (query.region) where.region = { contains: query.region };
    if (query.type) where.noticeType = query.type;
    if (query.from || query.to) where.publishedAt = { gte: query.from ? new Date(query.from) : undefined, lte: query.to ? new Date(query.to) : undefined };
    if (query.query) where.matches = { some: { query: query.query } };
    if (query.accessLevel) where.accessLevel = query.accessLevel;
    if (query.relevance) where.relevance = query.relevance;
    if (query.validOnly === 'true') {
      // Re-evaluate deadlines at read time: a saved OPEN record can expire between runs.
      where.AND = [{ relevance: 'RELATED' }, { detailStatus: 'COMPLETE' }, { followUpStatus: { not: 'CANCELLED' } },
        { OR: [{ fileDeadline: null }, { fileDeadline: { gte: new Date() } }] },
        { OR: [{ bidDeadline: null }, { bidDeadline: { gte: new Date() } }] },
        { OR: [{ noticeType: 2 }, { fileDeadline: { not: null } }, { bidDeadline: { not: null } }] }];
    }
    const [total, items] = await this.db.$transaction([
      this.db.project.count({ where }),
      this.db.project.findMany({ where, take: query.pageSize, skip: (query.page - 1) * query.pageSize,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], omit: { bodyHtml: true, bodyText: true, contactsJson: true, contentHash: true, deadlineEvidence: true,
          attachmentsJson: true, timelineJson: true, tagsJson: true, listingDataJson: true, detailDataJson: true },
        include: { matches: { select: { query: true, lastSeenAt: true } } } }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items: items.map(item => ({ ...item,
      followUpStatus: item.followUpStatus === 'CANCELLED' ? 'CANCELLED' : followUp(item.noticeType, item.fileDeadline, item.bidDeadline, ''),
    })) };
  }
  async get(id: string) {
    const project = await this.db.project.findUnique({ where: { id }, include: { matches: true } });
    if (!project) throw new NotFoundException('项目不存在');
    const { contactsJson, deadlineEvidence, attachmentsJson, timelineJson, tagsJson, listingDataJson, detailDataJson, ...rest } = project;
    return { ...rest, followUpStatus: project.followUpStatus === 'CANCELLED' ? 'CANCELLED' : followUp(project.noticeType, project.fileDeadline, project.bidDeadline, ''),
      contacts: JSON.parse(contactsJson), deadlineEvidence: JSON.parse(deadlineEvidence), attachments: JSON.parse(attachmentsJson),
      timeline: JSON.parse(timelineJson), tags: JSON.parse(tagsJson), listingData: JSON.parse(listingDataJson), detailData: JSON.parse(detailDataJson) };
  }
}
