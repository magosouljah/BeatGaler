// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  authorize: vi.fn(), reserve: vi.fn(), cancel: vi.fn(), upload: vi.fn(), projectUpload: vi.fn(),
  importCommit: vi.fn(), editCommit: vi.fn(), pointer: vi.fn(),
}));

vi.mock('../../src/features/cloud/webTransportSession', () => ({
  authorizeWebTransportProject: spies.authorize,
  uploadWebTransportProject: spies.projectUpload,
  reserveWebTransportBeat: spies.reserve,
  renewWebTransportBeat: vi.fn(),
  cancelWebTransportBeat: spies.cancel,
  ensureWebTransportTopic: vi.fn(async () => 42),
  publishWebTransportIndex: vi.fn(),
  commitWebTransportIndexPointer: spies.pointer,
  reconcileWebTransportRouting: vi.fn(),
}));
vi.mock('../../src/features/import/webImportCommit', () => ({ commitWebImportedBeat: spies.importCommit }));
vi.mock('../../src/features/edit/webBeatEdit', () => ({ commitWebBeatEdit: spies.editCommit }));
vi.mock('../../src/features/cloud/webTransportController', () => ({ WebTransportController: class {} }));
vi.mock('../../src/features/cloud/webTransportWorkerClient', () => ({ WebTransportWorkerClient: class {} }));

import { WebGalerCloudTransport } from '../../src/features/cloud/webGalerCloudTransport';
import type { Beat } from '../../src/types';

function createTransport() {
  const lease = { operationId: 'cap_project', sessionId: 'session-a', generation: 1,
    scope: { objectType: 'beat', objectIds: ['beat-a'] }, livenessTimeoutMs: 15_000 };
  const controller = { connect: vi.fn(async () => {}), beginOperation: vi.fn(async () => lease),
    endOperation: vi.fn(async () => {}) };
  const worker = { upload: spies.upload };
  const transport = Object.assign(Object.create(WebGalerCloudTransport.prototype), {
    controller, worker, uploadCheckpoints: new Map(),
  }) as WebGalerCloudTransport;
  return { transport, controller, lease };
}

const beat = { id: 'beat-a', name: 'Beat A', telegram_message_id: 99 } as Beat;
const master = new File([new Uint8Array([1])], 'master.mp3', { type: 'audio/mpeg' });
const project = new File([new Uint8Array([1, 2, 3])], 'project.zip', { type: 'application/zip' });

beforeEach(() => {
  vi.clearAllMocks();
  spies.authorize.mockResolvedValue(undefined);
  spies.reserve.mockResolvedValue(undefined);
  spies.cancel.mockResolvedValue(undefined);
  spies.pointer.mockResolvedValue(undefined);
  spies.upload.mockResolvedValue({ telegram_file_id: 'direct:88', telegram_message_id: 88,
    original_size: 3, filename: 'project.zip', parts: [], transport: 'direct-web' });
  spies.projectUpload.mockResolvedValue({ telegram_file_id: 'direct:88', telegram_message_id: 88,
    original_size: 3, filename: 'project.zip', parts: [], transport: 'direct-web' });
  spies.importCommit.mockImplementation(async (_beat, _files, runtime) => {
    await runtime.upload({ file: project, filename: project.name, beatId: beat.id, beatName: beat.name, kind: 'PROJECT' });
    return { beat, index: null };
  });
  spies.editCommit.mockResolvedValue({ beat, index: { messageId: 101, previousMessageId: 100, beatCount: 1 } });
});

describe('PROJECT Web operation boundary', () => {
  it('rejects Free before reserving a beat or sending PROJECT bytes', async () => {
    const { transport } = createTransport();
    spies.authorize.mockRejectedValueOnce(new Error('PROJECT upload is not available on this plan.'));
    await expect(transport.commitImportedBeat(beat, { master, project }, 'source'))
      .rejects.toThrow('PROJECT upload is not available');
    expect(spies.reserve).not.toHaveBeenCalled();
    expect(spies.upload).not.toHaveBeenCalled();
    expect(spies.projectUpload).not.toHaveBeenCalled();
  });

  it('authorizes import before reservation and again for the actual PROJECT file', async () => {
    const { transport, lease } = createTransport();
    await transport.commitImportedBeat(beat, { master, project }, 'source');
    expect(spies.authorize).toHaveBeenCalledWith(beat.id, project.size, lease, 'commit_import');
    expect(spies.authorize).toHaveBeenCalledTimes(2);
    expect(spies.authorize.mock.invocationCallOrder[0]).toBeLessThan(spies.reserve.mock.invocationCallOrder[0]);
    expect(spies.authorize.mock.invocationCallOrder[1]).toBeLessThan(spies.projectUpload.mock.invocationCallOrder[0]);
    expect(spies.upload).not.toHaveBeenCalled();
  });

  it('releases the pending beat slot when PROJECT upload fails', async () => {
    const { transport, lease } = createTransport();
    spies.projectUpload.mockRejectedValueOnce(new Error('Telegram upload interrupted'));
    await expect(transport.commitImportedBeat(beat, { master, project }, 'source'))
      .rejects.toThrow('Telegram upload interrupted');
    expect(spies.cancel).toHaveBeenCalledWith(beat.id, lease);
  });

  it('allows a metadata edit without asking for PROJECT upload permission', async () => {
    const { transport } = createTransport();
    await transport.commitBeatEdit(beat, { ...beat, name: 'Edited' }, {}, 'source');
    expect(spies.authorize).not.toHaveBeenCalled();
    expect(spies.pointer).toHaveBeenCalledOnce();
  });

  it('checks replacement PROJECT permission before edit preparation', async () => {
    const { transport } = createTransport();
    spies.authorize.mockRejectedValueOnce(new Error('PROJECT upload is not available on this plan.'));
    await expect(transport.commitBeatEdit(beat, beat, { PROJECT: project }, 'source'))
      .rejects.toThrow('PROJECT upload is not available');
    expect(spies.editCommit).not.toHaveBeenCalled();
  });
});
