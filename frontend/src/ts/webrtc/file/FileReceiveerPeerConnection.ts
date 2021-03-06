import {
  SetReceivingFileStatus,
  SetReceivingFileUploaded
} from '@/ts/types/types';
import {
  FileTransferStatus,
  ReceivingFile
} from '@/ts/types/model';
import { bytesToSize } from '@/ts/utils/pureFunctions';
import WsHandler from '@/ts/message_handlers/WsHandler';
import { requestFileSystem } from '@/ts/utils/htmlApi';
import {
  MAX_ACCEPT_FILE_SIZE_WO_FS_API,
  MAX_BUFFER_SIZE
} from '@/ts/utils/consts';
import FilePeerConnection from '@/ts/webrtc/file/FilePeerConnection';
import { DefaultStore } from '@/ts/classes/DefaultStore';
import {
  HandlerType,
  HandlerTypes
} from "@/ts/types/messages/baseMessagesInterfaces";
import {
  DestroyFileConnectionMessage,
  RetryFileMessage
} from "@/ts/types/messages/wsInMessages";

export default class FileReceiverPeerConnection extends FilePeerConnection {

  protected readonly handlers:  HandlerTypes<keyof FileReceiverPeerConnection, 'peerConnection:*'> = {
    sendRtcData: <HandlerType<'sendRtcData', 'peerConnection:*'>>this.sendRtcData,
    retryFile: <HandlerType<'retryFile', 'peerConnection:*'>>this.retryFile,
    retryFileReply:<HandlerType<'retryFileReply', 'peerConnection:*'>> this.retryFileReply,
    acceptFileReply: <HandlerType<'acceptFileReply', 'peerConnection:*'>>this.acceptFileReply,
    declineFileReply:<HandlerType<'declineFileReply', 'peerConnection:*'>> this.declineFileReply,
    destroyFileConnection: <HandlerType<'destroyFileConnection', 'peerConnection:*'>>this.destroyFileConnection
  };
  private readonly fileSize: number;
  private fileEntry: FileEntry |null = null;
  private fileWriter: FileWriter|null = null;
  private readonly blobsQueue: Blob[] = [];
  private receiveBuffer: BlobPart[] = [];
  private receivedSize = 0;
  private recevedUsingFile = false;

  private retryFileSend: number = 0;

  constructor(roomId: number, connId: string, opponentWsId: string, wsHandler: WsHandler, store: DefaultStore, size: number) {
    super(roomId, connId, opponentWsId, wsHandler, store);
    this.fileSize = size;
  }

  public retryFileReply() {
    const now = Date.now();
    if (now - this.retryFileSend > 5000) {
      this.retryFileSend = now;
      this.waitForAnswer();
    }

  }

  public declineFileReply() {
    this.wsHandler.destroyFileConnection(this.connectionId, 'decline');
    const rf: SetReceivingFileStatus = {
      roomId: this.roomId,
      connId: this.connectionId,
      status: FileTransferStatus.DECLINED_BY_YOU
    };
    this.store.setReceivingFileStatus(rf);
    this.unsubscribeAndRemoveFromParent();
  }

  public async acceptFileReply() {
    try {
      await this.initFileSystemApi();
    } catch (e) {
      this.logger.error('Error initing fs {}', e);
        if (this.fileSize > MAX_ACCEPT_FILE_SIZE_WO_FS_API) {
          const content = `Browser doesn't support accepting file sizes over ${bytesToSize(MAX_ACCEPT_FILE_SIZE_WO_FS_API)}`;
          this.wsHandler.destroyFileConnection(this.connectionId, content);
          this.commitErrorIntoStore(content);
          this.unsubscribeAndRemoveFromParent();
          throw e;
        }
    }
    this.commitErrorIntoStore('Establishing connection...');
    this.waitForAnswer();
  }

  protected onChannelMessage(event: MessageEvent) {
    this.receiveBuffer.push(event.data);
    // chrome accepts bufferArray (.byteLength). firefox accepts blob (.size)
    const receivedSize = event.data.byteLength ? event.data.byteLength : event.data.size;
    this.receivedSize += receivedSize;
    this.syncBufferWithFs();
    const payload: SetReceivingFileUploaded = {
      connId: this.connectionId,
      roomId: this.roomId,
      uploaded: this.receivedSize
    };
    this.store.setReceivingFileUploaded(payload);
    this.assembleFileIfDone();
  }

  public destroyFileConnection(message: DestroyFileConnectionMessage) {
    const payload: SetReceivingFileStatus = {
      error: null,
      status: FileTransferStatus.DECLINED_BY_OPPONENT,
      connId: this.connectionId,
      roomId: this.roomId
    };
    this.store.setReceivingFileStatus(payload);
    this.unsubscribeAndRemoveFromParent();
  }

  private async initFileSystemApi() {
    this.logger.debug('Creating temp location {}', bytesToSize(this.fileSize))();
    if (!requestFileSystem) {
      throw Error('Request FS is not available');
    }
    const fs: FileSystem | null = null;
    try {
      const fs: FileSystem = await new Promise<FileSystem>((resolve, reject) =>
          requestFileSystem(
              window.TEMPORARY,
              this.fileSize,
              resolve,
              reject
          )
      );
      this.fileEntry = await new Promise<FileEntry>((resolve, reject) =>
          fs.root.getFile(this.connectionId, {create: true}, resolve, reject)
      );
      this.fileWriter = await new Promise<FileWriter>((resolve, reject) =>
          this.fileEntry!.createWriter(resolve, reject)
      );

      if (!this.fileWriter.WRITING) {
        this.fileWriter.WRITING = 1;
      }
      this.fileWriter.onwriteend = this.onWriteEnd.bind(this);
      this.logger.log('FileWriter is created')();
    } catch (e) {
      this.logger.error('FileSystemApi Error: {}, code {}', e.message || e, e.code)();
      if (fs && e.code === 22) { // TODO move this to specific entry so we can recreate file
        await this.clearFS(fs);
      } else {
        this.store.growlError('FileSystemApi Error: ' + e.message || e.code || e);
      }
      throw e;
    }
  }

  public retryFile(message: RetryFileMessage) {
    const payload: SetReceivingFileStatus = {
      error: null,
      status: FileTransferStatus.IN_PROGRESS,
      connId: this.connectionId,
      roomId: this.roomId
    };
    this.store.setReceivingFileStatus(payload);
  }

  private syncBufferWithFs() {
    if (this.fileWriter && (this.receiveBuffer.length > MAX_BUFFER_SIZE || this.isDone())) {
      this.recevedUsingFile = true;
      const blob = new Blob(this.receiveBuffer);
      this.receiveBuffer = [];
      if (this.fileWriter.readyState === this.fileWriter.WRITING) {
        this.blobsQueue.push(blob);
      } else {
        this.fileWriter.write(blob);
      }
    }
  }

  private onWriteEnd() {
    if (this.blobsQueue.length > 0) {
      this.fileWriter!.write(this.blobsQueue.shift()!);
    } else {
      this.assembleFileIfDone();
    }
  }
  private isDone() {
    return this.receivedSize === this.fileSize;
  }

  private assembleFileIfDone () {
    if (this.isDone()) {
      const received = this.recevedUsingFile ? this.fileEntry!.toURL() : URL.createObjectURL(new window.Blob(this.receiveBuffer));
      this.logger.log('File is received')();
      this.wsHandler.destroyFileConnection(this.connectionId, 'success');
      this.receiveBuffer = []; // clear buffer
      this.receivedSize = 0;
      const payload: SetReceivingFileStatus = {
        anchor: received,
        error: null,
        status: FileTransferStatus.FINISHED,
        connId: this.connectionId,
        roomId: this.roomId
      };
      this.store.setReceivingFileStatus(payload);
      this.unsubscribeAndRemoveFromParent();
    }
  }

  private async clearFS(fs: FileSystem) {
    this.logger.log('Quota exceeded, trying to clear it')();
    const entries: Entry[] = await new Promise<Entry[]>((resolve, reject) =>
        fs.root.createReader().readEntries(resolve, reject)
    );
    await Promise.all(entries.map(async (e: Entry) => {
      if (e.isFile) {
        await new Promise<void>((resolve, reject) => e.remove(resolve, reject));
        this.logger.log('Removed file {}', e.fullPath)();
      } else {
        await new Promise<void>((resolve, reject) => (<DirectoryEntry>e).removeRecursively(resolve, reject));
        this.logger.log('Removed directory {}', e.fullPath)();
      }
    }));
  }

  private gotReceiveChannel(event: RTCDataChannelEvent) {
    this.logger.debug('Received new channel')();
    this.sendChannel = event.channel;
    this.sendChannel.onmessage = this.onChannelMessage.bind(this);
    this.sendChannel.onopen = () => {
      this.logger.debug('Channel opened')();
    };
    this.sendChannel.onclose = () => this.logger.log('Closed channel ')();
  }

  private waitForAnswer() {
    this.createPeerConnection();
    this.pc!.ondatachannel = this.gotReceiveChannel.bind(this);
    this.wsHandler.acceptFile(this.connectionId, this.receivedSize);
  }

  get receivingFile() : ReceivingFile {
    return this.store.roomsDict[this.roomId].receivingFiles[this.connectionId];
  }

  commitErrorIntoStore(error: string, onlyIfNotFinished: boolean = false): void {
    if (onlyIfNotFinished && this.receivingFile.status === FileTransferStatus.FINISHED) {
      return
    }
    const ssfs: SetReceivingFileStatus = {
      status: FileTransferStatus.ERROR,
      roomId: this.roomId,
      error,
      connId: this.connectionId
    };
    this.store.setReceivingFileStatus(ssfs);
  }

}
