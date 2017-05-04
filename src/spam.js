import {
  Plugin,
  respond,
  listen,
  help,
  permissionGroup,
  PropTypes as T,
  AdapterOperationTypes as AT } from '@exoplay/exobot';
import { RegexpTokenizer, JaroWinklerDistance, WordTokenizer } from 'natural';
import { intersection, merge } from 'lodash';
import isURL from 'validator/lib/isURL';

export default class Spam extends Plugin {
  static type = 'spam';

  static propTypes = {
    messageCount: T.number,
    messageTimeout: T.number.isRequired,
    messageHistory: T.number,
    messageSimilarity: T.number,
    urlFilterEnabled: T.bool,
    wordFilter: T.oneOfType([T.string, T.array]),
    initialPenalty: T.number,
    penaltyMultiplier: T.number,
    banThreshold: T.number,
    goodBehaviorTime: T.number,
    wordFilterEnabled: T.bool,
    roleSettings: T.oneOfType([T.string, T.object]),
  };

  static defaultProps = {
    messageCount: 3,
    messageTimeout: 10,
    messageHistory: 2,
    messageSimilarity: 90,
    urlFilterEnabled: true,
    initialPenalty: 10,
    penaltyMultiplier: 3,
    banThreshold: 6,
    goodBehaviorTime: 10,
    wordFilterEnabled: true,
  };

  constructor() {
    super(...arguments);
    this.spamUsers = {};
    const tokenizer = new RegexpTokenizer({pattern: /\,/});

    try {
      if (typeof this.options.wordFilter === 'string') {
        this.options.wordFilter = tokenizer.tokenize(this.options.wordFilter.toLowerCase());
      }
    } catch (err) {
      this.bot.log.warning(err);
    }

    try {
      if (typeof this.options.roleSettings === 'string') {
        this.options.roleSettings = JSON.parse(this.options.roleSettings);
      }
    } catch (err) {
      this.options.roleSettings = {};
      this.bot.log.warning(err);
    }

  }

  @help('Checks all messages against spam plugin')
  @permissionGroup('public');
  @listen(/^.*$/i);
  checkMessage(match, m) {
    let err;
    const userMsg = [];
    if (!m.whisper) {
      if (!this.spamUsers[m.user.id]) {
        this.spamUsers[m.user.id] = this.newUser(m);
      }
      let messageHistory = this.options.messageHistory;
      let messageSimilarity = this.options.messageSimilarity;
      let messageTimeout = this.options.messageTimeout;
      let messageCount = this.options.messageCount;
      let URLFilter = this.options.urlFilterEnabled;
      let wordFilter = this.options.wordFilterEnabled;

      if (this.options.roleSettings) {
        const userRoles = this.bot.getUserRoles(m.user.id);
        userRoles.forEach(r => {
          const role = this.options.roleSettings[r];
          if (role) {
            if (this.options.roleSettings[r] && !this.options.roleSettings[r].urlFilterEnabled) {
              URLFilter = false;
            }
            if (this.options.roleSettings[r] && !this.options.roleSettings[r].wordFilterEnabled) {
              wordFilter = false;
            }
            if (typeof role.messageCount !== 'undefined') {
              messageHistory = role.messageHistory;
            }
            if (typeof role.messageTimeout !== 'undefined') {
              messageSimilarity = role.messageSimilarity;
            }
            if (typeof role.messageCount !== 'undefined') {
              messageCount = role.messageCount;
            }
            if (typeof role.messageTimeout !== 'undefined') {
              messageTimeout = role.messageTimeout;
            }
          }
        });
      }

      err = this.checkContentFilters(m, URLFilter, wordFilter);
      if (err) {userMsg.push(err);}
      err = this.checkRate(m, messageTimeout, messageCount);
      if (err) {userMsg.push(err);}
      err = this.checkSimilarity(m, messageHistory, messageSimilarity);
      if (err) {userMsg.push(err);}
      this.bot.log.debug(userMsg);
      if (userMsg.length) {
        this.punishUser(m, userMsg.join(', '));
      } else {
        this.checkGoodBehavior(m);
      }
    }
  }

  newUser() {
    return {
      punishCount: 0,
      punishTime: 0,
      punishMsgId: '',
      messageCount: 0,
      messageTime: Date.now(),
      historyNum:0,
      history: {},
    };
  }

  punishUser(message, reason) {
    this.bot.log.debug(reason);
    const user = this.spamUsers[message.user.id];
    user.punishTime = Date.now();
    user.punishMsgId = message.id;
    if (++user.punishCount > this.options.banThreshold) {
      this.bot.emitter.emit(AT.DISCIPLINE_USER_PERMANENT, false, {
        userId: message.user.id,
        messageText: reason,
      });
    } else {
      const userMult = this.options.penaltyMultiplier * (user.punishCount - 1);
      const duration = this.options.initialPenalty * (userMult || 1);
      this.bot.emitter.emit(AT.DISCIPLINE_USER_TEMPORARY, false, {
        userId: message.user.id,
        messageText: reason,
        duration,
      });
    }
  }

  checkSimilarity = (message, messageHistory, messageSimilarity) => {
    const user = this.spamUsers[message.user.id];

    if (messageHistory) {
      Object.keys(user.history)
        .forEach(h => {
          if (h >= messageHistory) {
            delete user.history[h];
          }
        });
      const leastDifferent = Object.keys(user.history)
        .reduce((p, c) => Math.max(JaroWinklerDistance(message.text, user.history[c])*100, p), 0);
      if (user.historyNum++ >= messageHistory) {
        user.historyNum = 0;
      }

      user.history[user.historyNum] = message.text;
      if (leastDifferent > messageSimilarity) {
        return 'Message too similar to history';
      }
    }

    return false;
  }

  checkRate = (message, messageTimeout, messageCount) => {
    const user = this.spamUsers[message.user.id];

    if (messageCount > 0 && messageTimeout > 0) {
      if (Date.now() < user.messageTime + messageTimeout * 1000) {
        if (++user.messageCount > messageCount) {
          return 'Exceeded message rate';
        }
      } else {
        user.messageTime = Date.now();
        user.messageCount = 1;
      }
    }

    return false;
  }

  checkContentFilters = (message, URLFilter, wordFilter) => {
    const wordTokenizer = new WordTokenizer();
    const urlTokenizer = new RegexpTokenizer({pattern: /\s/});
    const wordArray = wordTokenizer.tokenize(message.text.toLowerCase());
    const urlArray = urlTokenizer.tokenize(message.text.toLowerCase());
    const filterMsgs = [];

    if (this.options.wordFilter && wordFilter) {
      if (intersection(this.options.wordFilter, wordArray).length) {
        filterMsgs.push('Used filtered word');
      }
    }

    if (URLFilter) {
      if (urlArray.reduce((p, c) => p || isURL(c), false)) {
        filterMsgs.push('URL detected and not allowed');
      }
    }

    if (filterMsgs.length) {
      return filterMsgs.join(', ');
    }

    return false;
  }

  checkGoodBehavior = (message) => {
    const user = this.spamUsers[message.user.id];
    if (user.punishCount) {
      if (user.punishTime + this.options.goodBehaviorTime * 1000 < Date.now()) {
        user.punishTime = Date.now();
        user.punishCount--;
      }
    }
  }

  @help('/spam set <role> configurationItem value');
  @permissionGroup('config');
  @respond(/^spam set (\S+) (\S+) (\d+)/i);
  setConfig([, role, configurationItem, value]) {
    switch (configurationItem.toLowerCase()) {
      case 'messageCount':
        merge(this.options.roleSettings, {
          [role]: {
            messageCount: value,
          },
        });
        return 'Message rate configured.';
      case 'messageTimeout':
        merge(this.options.roleSettings, {
          [role]: {
            messageTimeout: value,
          },
        });
        return 'Message rate configured.';
      case 'messageSimilarity':
        merge(this.options.roleSettings, {
          [role]: {
            messageSimilarity: value,
          },
        });
        return 'Message silimarity score configured.';
      case 'messageHistory' :
        merge(this.options.roleSettings, {
          [role]: {
            messageHistory: value,
          },
        });
        return 'Message history length configured.';
      default:
        return 'Unknown configurationItem';
    }
  }

  @help('/spam enable/disable word filter');
  @permissionGroup('config');
  @respond(/^spam (enable|disable) word filter\s*(?:for (\S+))?/i);
  toggleWordFilter([, op, role]) {
    switch (op) {
      case 'enable':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              wordFilterEnabled: true,
            },
          });
          return `Word filter enabled for role:${role}`;
        }
        this.options.wordFilterEnabled = true;
        return 'Word filter enabled';
      case 'disable':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              wordFilterEnabled: false,
            },
          });
          return `Word filter disabled for role:${role}`;
        }
        this.options.wordFilterEnabled = false;
        return 'Word filter disabled';
    }
  }

  @help('/spam enable/disable URL filter');
  @permissionGroup('config');
  @respond(/^spam (enable|disable) url filter\s*(?:for (\S+))?/i);
  toggleUrlFilter([, op, role]) {
    switch (op) {
      case 'enable':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              urlFilterEnabled: true,
            },
          });
          return `URL filter enabled for role:${role}`;
        }
        this.options.urlFilterEnabled = true;
        return 'URL filter enabled';
      case 'disable':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              urlFilterEnabled: false,
            },
          });
          return `URL filter disabled for role:${role}`;
        }
        this.options.urlFilterEnabled = false;
        return 'URL filter disabled';
    }
  }

  @help('/spam add/remove word <word>');
  @permissionGroup('config');
  @respond(/^spam (add|remove) word (.+)/);
  modifyWordList([, op, word]) {
    switch (op) {
      case 'add': {
        this.options.wordFilter.push(word.toLowerCase());
        return 'Word added to filter';
      }
      case 'remove': {
        const index = this.options.wordFilter.indexof(word.toLowerCase());
        if (index > -1) {
          this.option.wordFilter.splice(index,1);
          return 'Word removed from filter';
        }
        return 'Word not found';
      }
    }
  }
}
