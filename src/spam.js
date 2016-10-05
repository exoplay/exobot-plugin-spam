import { ChatPlugin, respond, help, permissionGroup, PropTypes as T } from '@exoplay/exobot';
import { RegexpTokenizer, JaroWinklerDistance, WordTokenizer } from 'natural';
import { intersection, merge } from 'lodash';
import isURL from 'validator/lib/isURL';

export default class Spam extends ChatPlugin {
  name = 'spam';

  propTypes = {
    messageCount: T.number,
    messageTimeout: T.number,
    messageHistory: T.number,
    messageSimilarity: T.number,
    urlFilterEnabled: T.bool,
    wordFilter: T.any([T.string, T.array]),
    initialPenalty: T.number,
    penaltyMultiplier: T.number,
    banThreshold: T.number,
    goodBehaviorTime: T.number,
    wordFilterEnabled: T.bool,
    roleSettings: T.any([T.string, T.object]),
  };

  defaultProps = {
    messageCount: 2,
    messageTimeout: 1,
    messageHistory: 2,
    messageSimilarity: 90,
    urlFilterEnabled: true,
    initialPenalty: 10,
    penaltyMultiplier: 3,
    banThreshold: 6,
    goodBehaviorTime: 3600,
    wordFilterEnabled: true,
  }

  constructor () {
    super(...arguments);
    this.spamUsers = {};
  }

  register (bot) {
    super.register(bot);
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

    this.bot.emitter.on('receive-message', m => {
      if (!m.whisper) {
        if (!this.spamUsers[m.user.id]) {
          this.spamUsers[m.user.id] = this.newUser(m);
        }
        if (!this.checkContentFilters(m)) {
          if (!this.checkRate(m)) {
            if (!this.checkSimilarity(m)) {
              this.checkGoodBehavior(m);
            }
          }
        }
      }
    });
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
    const user = this.spamUsers[message.user.id];
    user.punishTime = Date.now();
    if (user.punishMsgId !== message.id) {
      user.punishMsgId = message.id;
      if (++user.punishCount > this.options.banThreshold) {
        this.bot.emitter.emit('adapter-operation', {
          type: 'disciplineUser',
          subtype: 'permanent',
          userId: message.user.id,
          messageText: reason,
        });
      } else {
        const userMult = this.options.penaltyMultiplier * (user.punishCount - 1);
        const duration = this.options.initialPenalty * (userMult || 1);
        this.bot.emitter.emit('adapter-operation', {
          type: 'disciplineUser',
          subtype: 'temporary',
          userId: message.user.id,
          messageText: reason,
          duration,
        });
      }
    }
  }

  checkSimilarity = (message) => {
    const user = this.spamUsers[message.user.id];
    const userRoles = this.bot.getUserRoles(message.user.id);
    let messageHistory = this.options.messageHistory;
    let messageSimilarity = this.options.messageSimilarity;
    userRoles.forEach(r => {
      const role = this.options.roleSettings[r];
      if (role) {
        if (typeof role.messageCount !== 'undefined') {
          messageHistory = role.messageHistory;
        }
        if (typeof role.messageTimeout !== 'undefined') {
          messageSimilarity = role.messageSimilarity;
        }
      }
    });
    if (messageHistory) {
      const leastDifferent = Object.keys(user.history)
        .forEach(h => {
          if (h >= messageHistory) {
            delete user.history[h];
          }
        })
        .reduce((p, c) => Math.max(JaroWinklerDistance(message.text, user.history[c])*100, p), 0);
      if (user.historyNum++ >= messageHistory) {
        user.historyNum = 0;
      }
      user.history[user.historyNum] = message.text;
      if (leastDifferent > messageSimilarity) {
        this.punishUser(message, 'messages too similar');
        return true;
      }
    }
  }

  checkRate = (message) => {
    const user = this.spamUsers[message.user.id];
    const userRoles = this.bot.getUserRoles(message.user.id);
    let messageTimeout = this.options.messageTimeout;
    let messageCount = this.options.messageCount;
    userRoles.forEach(r => {
      const role = this.options.roleSettings[r];
      if (role) {
        if (typeof role.messageCount !== 'undefined') {
          messageCount = role.messageCount;
        }
        if (typeof role.messageTimeout !== 'undefined') {
          messageTimeout = role.messageTimeout;
        }
      }
    });
    if (user) {
      if (Date.now() < user.messageTime + messageTimeout * 1000) {
        if (user.messageCount++ > messageCount) {
          this.punishUser(message, 'exceeded message rate');
          return true;
        }
      } else {
        user.messageTime = Date.now();
        user.messageCount = 1;
      }
    } else {
      this.spamUsers[message.user.id] = this.newUser();
    }
  }

  checkContentFilters = (message) => {
    const wordTokenizer = new WordTokenizer();
    const urlTokenizer = new RegexpTokenizer({pattern: /\s/});
    const wordArray = wordTokenizer.tokenize(message.text.toLowerCase());
    const urlArray = urlTokenizer.tokenize(message.text.toLowerCase());
    const userRoles = this.bot.getUserRoles(message.user.id);
    let userURLFilter = true;
    if (this.options.wordFilter && this.options.wordFilterEnabled) {
      if (intersection(this.options.wordFilter, wordArray).length) {
        this.punishUser(message, 'used filtered word');
        return true;
      }
    }

    userRoles.forEach(r => {
      if (this.options.roleSettings[r] && !this.options.roleSettings[r].urlFilterEnabled) {
        userURLFilter = false;
      }
    });

    if (this.options.urlFilterEnabled && userURLFilter) {
      if (urlArray.reduce((p, c) => p || isURL(c), false)) {
        this.punishUser(message, 'URL detected');
        return true;
      }

    }
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

  @permissionGroup('config');
  @help('/spam set <configurationItem> [for <role>] option');
  @respond(/^spam set (rate|similarty|message|first|timeout|ban|good).*?(?:for (\S+))?\s*(?:(\d+)\/?(\d+)?)/i);
  setConfig([, command, role, option1, option2]) {
    switch (command.toLowerCase()) {
      case 'rate':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              messageCount: option1,
              messageTimeout: option2,
            },
          });
        } else {
          this.options.messageCount = option1;
          this.options.messageTimeout = option2;
        }
        return 'Message rate configured.';
      case 'similarity':
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              messageSimilarity: option1,
            },
          });
        } else {
          this.options.messageSimilarity = option1;
        }
        return 'Message silimarity score configured.';
      case 'message' :
        if (role) {
          merge(this.options.roleSettings, {
            [role]: {
              messageHistory: option1,
            },
          });
        } else {
          this.options.messageHistory = option1;
        }
        return 'Message history length configured.';
      case 'first' :
        this.options.initialPenalty = option1;
        return 'Initial penalty configured.';
      case 'timeout' :
        this.options.penaltyMultiplier = option1;
        return 'Penalty multiplier configured.';
      case 'ban' :
        this.option.banThreshold = option1;
        return 'Ban threshold configured.';
      case 'good' :
        this.options.goodBehaviorTime = option1;
        return 'Good behavior time configured.';
    }
  }

  @permissionGroup('config');
  @help('/spam enable/disable word filter');
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

  @permissionGroup('config');
  @help('/spam enable/disable URL filter');
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

  @permissionGroup('config');
  @help('/spam add/remove word <word>');
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
