import {Logger} from './Logger';
import {API_URL, CLIENT_NO_SERVER_PING_CLOSE_TIMEOUT, CONNECTION_RETRY_TIME, PING_CLOSE_JS_DELAY} from './consts';
import {Store} from 'vuex';
import {VueRouter} from 'vue-router/types/router';
import {
  CurrentUserInfo,
  IStorage,
  RoomModel,
  RootState,
  SessionHolder,
  UserModel
} from '../types';
import ChannelsHandler from './ChannelsHandler';
import loggerFactory from './loggerFactory';
import {DefaultMessage, MessageHandler, RoomDTO} from './dto';

enum WsState {
  NOT_INITED, TRIED_TO_CONNECT, CONNECTION_IS_LOST, CONNECTED
}

interface SetWsIdMessage extends DefaultMessage {
  rooms: { [id: number]: RoomDTO };
  users: { [id: number]: UserModel };
  online: number[];
  opponentWsId: string;
  userInfo: CurrentUserInfo;
}

interface AllHandlers {
  channels: ChannelsHandler;
  chat: MessageHandler;
  ws: WsHandler;
  webrtc: MessageHandler;
  webrtcTransfer: MessageHandler;
  peerConnection: MessageHandler;
  growl: MessageHandler;
}
export class WsHandler implements MessageHandler {

  private logger: Logger;
  private pingTimeoutFunction;
  private ws: WebSocket;
  private noServerPingTimeout: any;
  private loadHistoryFromWs: boolean;
  private storage: IStorage;
  private store: Store<RootState>;
  private router: VueRouter;
  private sessionHolder: SessionHolder;
  private listenWsTimeout: number;
  private callBacks: { [id: number]: Function } = {};

  constructor(sessionHolder: SessionHolder, channelsHandler: ChannelsHandler, webRtcApi, storage: IStorage, store: Store<RootState>, router: VueRouter) {
    this.logger = loggerFactory.getLogger('WS', 'color: green;');
    this.storage = storage;
    this.sessionHolder = sessionHolder;
    this.store = store;
    this.router = router;
    this.handlers = {
      channels: channelsHandler,
      chat: channelsHandler,
      ws: this,
      webrtc: webRtcApi,
      webrtcTransfer: webRtcApi,
      peerConnection: webRtcApi,
      growl: {
        handle: function (message) {
          // alert(message.content);
          // growlError(message.content);
        }
      }
    };
  }

  private messageId: number = 0;
  private wsState: WsState = WsState.NOT_INITED;
  private duplicates = {};


  private logData(tag, obj, raw) {
    if (raw.length > 1000) {
      raw = '';
    }
    return loggerFactory.getSingleLogger(tag, 'color: green; font-weight: bold', console.log)('{} {}', raw, obj);
  }

  // this.dom = {
  //   onlineStatus: $('onlineStatus'),
  //   onlineClass: 'online',
  //   offlineClass: OFFLINE_CLASS
  // };
  private progressInterval = {};
  private wsConnectionId = '';

  private handlers: AllHandlers;

  public handle(message: DefaultMessage) {
    this['handle' + message.action](message);
  }

  handlesetWsId(message: SetWsIdMessage) {
    this.wsConnectionId = message.opponentWsId;
    this.store.commit('setUserInfo', message.userInfo);
    this.handlers.channels.setRooms(message.rooms);
    this.handlers.channels.setOnline(message.online);
    this.handlers.channels.setUsers(message.users);
    this.logger.log('CONNECTION ID HAS BEEN SET TO {})', this.wsConnectionId)();
  }

  onWsMessage(message) {
    let jsonData = message.data;
    let data: DefaultMessage;
    try {
      data = JSON.parse(jsonData);
      this.logData('WS_IN', data, jsonData)();
    } catch (e) {
      this.logger.error('Unable to parse incomming message {}', jsonData)();
      return;
    }
    this.handleMessage(data);
  }

  handleMessage(data) {
    this.handlers[data.handler].handle(data);
    if (this.callBacks[data.messageId]) {
      this.logger.debug('resolving cb')();
      this.callBacks[data.messageId]();
      delete this.callBacks[data.messageId];
    }
  }


  private sendToServer(messageRequest, skipGrowl = false) {
    this.messageId++;
    messageRequest.messageId = this.messageId;
    let jsonRequest = JSON.stringify(messageRequest);
    return this.sendRawTextToServer(jsonRequest, skipGrowl, messageRequest);
  }

  private hideGrowlProgress(key) {
    let progInter = this.progressInterval[key];
    if (progInter) {
      this.logger.log('Removing progressInterval {}', key)();
      progInter.growl.hide();
      if (progInter.interval) {
        clearInterval(progInter.interval);
      }
      delete this.progressInterval[key];
    }
  }

  isWsOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  sendRawTextToServer(jsonRequest, skipGrowl, objData) {
    let logEntry = jsonRequest.substring(0, 500);
    if (!this.isWsOpen()) {
      if (!skipGrowl) {
        alert('Can\'t send message, because connection is lost :(');
      }
      this.logger.error('Web socket is closed. Can\'t send {}', logEntry)();
      return false;
    } else {
      this.logData('WS_OUT', objData, jsonRequest)();
      this.ws.send(jsonRequest);
      return true;
    }
  }

  sendPreventDuplicates(data, skipGrowl) {
    this.messageId++;
    data.messageId = this.messageId;
    let jsonRequest = JSON.stringify(data);
    if (!this.duplicates[jsonRequest]) {
      this.duplicates[jsonRequest] = Date.now();
      this.sendRawTextToServer(jsonRequest, skipGrowl, data);
      setTimeout(() => {
        delete this.duplicates[jsonRequest];
      }, 5000);
    } else {
      this.logger.warn('blocked duplicate from sending: {}', jsonRequest)();
    }
  }


  setStatus(isOnline) {
    this.store.commit('setIsOnline', isOnline);
  }

  close() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }

  public sendEditMessage(content: string, id: number, files: any[]) {
    this.sendToServer({
      id,
      action: 'editMessage',
      files,
      content
    });
  }

  public sendSendMessage(content: string, roomId: number, files: any[]) {
    this.sendToServer({
      files,
      action: 'sendMessage',
      content,
      roomId
    });
  }


  public sendLoadMessages(roomId: number, headerId: number, count: number, cb: Function) {
    this.sendToServer({
      headerId,
      count,
      action: 'loadMessages',
      roomId
    });
    this.callBacks[this.messageId] = cb;
  }


  onWsClose(e) {
    this.setStatus(false);
    for (let k in this.progressInterval) {
      this.hideGrowlProgress(k);
    }
    let reason = e.reason || e;
    if (e.code === 403) {
      let message = `Server has forbidden request because '${reason}'. Logging out...`;
      alert(message);
      this.logger.error('onWsClose {}', message)();
      this.router.replace('/auth/login');
      return;
    } else if (this.wsState === WsState.NOT_INITED) {
      alert('Can\'t establish connection with server');
      this.logger.error('Chat server is down because {}', reason)();
      this.wsState = WsState.TRIED_TO_CONNECT;
    } else if (this.wsState === WsState.CONNECTED) {
      alert(`Connection to chat server has been lost, because ${reason}`);
      this.logger.error(
          'Connection to WebSocket has failed because "{}". Trying to reconnect every {}ms',
          e.reason, CONNECTION_RETRY_TIME)();
    }
    if (this.wsState !== 1) {
      this.wsState = 2;
    }
    // Try to reconnect in 10 seconds
    this.listenWsTimeout = setTimeout(this.listenWS.bind(this), CONNECTION_RETRY_TIME);
  }

  public startListening() {
    this.logger.log('Starting webSocket')();
    if (!this.listenWsTimeout && !this.ws) {
      this.listenWS();
    }
  }

  public stopListening() {
    this.logger.log('Finishing websocket')();
    if (this.listenWsTimeout) {
      this.listenWsTimeout = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }




  public listenWS() {
    if (typeof WebSocket === 'undefined') {
      // TODO
      // alert('Your browser ({}) doesn\'t support webSockets. Supported browsers: ' +
      //     'Android, Chrome, Opera, Safari, IE11, Edge, Firefox'.format(window.browserVersion));
      return;
    }
    this.storage.getIds((ids) => {
      let s = API_URL + this.wsConnectionId;
      if (Object.keys(ids).length > 0) {
        s += `&messages=${encodeURI(JSON.stringify(ids))}`;
      }
      if (this.loadHistoryFromWs && this.wsState !== WsState.CONNECTION_IS_LOST) {
        s += '&history=true';
      }
      s += `&sessionId=${this.sessionHolder.session}`;

      this.ws = new WebSocket(s);
      this.ws.onmessage = this.onWsMessage.bind(this);
      this.ws.onclose = this.onWsClose.bind(this);
      this.ws.onopen = () => {
        this.setStatus(true);
        let message = 'Connection to server has been established';
        if (this.wsState === 2) { // if not inited don't growl message on page load
          // alert(message); TODO
        }
        this.startNoPingTimeout();
        this.wsState = 9;
        this.logger.log(message)();
      };
    });
  }


  startNoPingTimeout() {
    if (this.noServerPingTimeout) {
      clearTimeout(this.noServerPingTimeout);
      this.logger.log('Clearing noServerPingTimeout')();
      this.noServerPingTimeout = null;
    }
    this.noServerPingTimeout = setTimeout(() => {
      this.logger.error('Force closing socket coz server didn\'t ping us')();
      this.ws.close(1000, 'Sever didn\'t ping us');
    }, CLIENT_NO_SERVER_PING_CLOSE_TIMEOUT);
  }

  handleping(message) {
    this.startNoPingTimeout();
    this.sendToServer({action: 'pong', time: message.time});
  }

  pingServer() {
    if (this.sendToServer({action: 'ping'}, true)) {
      this.handlepong();
      this.pingTimeoutFunction = setTimeout(() => {
        this.logger.error('Force closing socket coz pong time out')();
        this.ws.close(1000, 'Ping timeout');
      }, PING_CLOSE_JS_DELAY);
    }
  }

  handlepong() {
    if (this.pingTimeoutFunction) {
      this.logger.debug('Clearing pingTimeoutFunction')();
      clearTimeout(this.pingTimeoutFunction);
      this.pingTimeoutFunction = null;
    }
  }
}