require('dotenv').config();

const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

// ============ 설정 ============
const config = {
  newRelicApiKey: process.env.NEWRELIC_API_KEY,
  newRelicAccountId: process.env.NEWRELIC_ACCOUNT_ID || '7617380',
  newRelicAppName: process.env.NEWRELIC_APP_NAME || 'pongift-partners-api',
  newRelicHostnameLike: process.env.NEWRELIC_HOSTNAME_LIKE || 'dev%',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  scheduleInterval: process.env.SCHEDULE_INTERVAL || '0 0 * * * *',
  timezone: process.env.TIMEZONE || 'Asia/Seoul',
  logDir: process.env.LOG_DIR || './logs',
  enableChannelMentionOnCritical:
    String(process.env.ENABLE_CHANNEL_MENTION_ON_CRITICAL || 'true').toLowerCase() === 'true'
};

// ============ 로그 ============
function ensureLogDir() {
  if (!fs.existsSync(config.logDir)) {
    fs.mkdirSync(config.logDir, { recursive: true });
  }
}

function getLogFilePath() {
  const date = moment().tz(config.timezone).format('YYYY-MM-DD');
  return path.join(config.logDir, `dashboard-analyzer-${date}.log`);
}

const log = {
  write(level, msg) {
    const line = `[${level}] ${moment().tz(config.timezone).format('YYYY-MM-DD HH:mm:ss')} - ${msg}`;
    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }

    try {
      ensureLogDir();
      fs.appendFileSync(getLogFilePath(), line + '\n', 'utf8');
    } catch (err) {
      console.error(`[ERROR] 로그 저장 실패 - ${err.message}`);
    }
  },
  info(msg) {
    this.write('INFO', msg);
  },
  error(msg) {
    this.write('ERROR', msg);
  },
  success(msg) {
    this.write('OK', msg);
  }
};

// ============ 설정 검증 ============
function validateConfig() {
  const errors = [];

  if (!config.newRelicApiKey) errors.push('NEWRELIC_API_KEY 미설정');
  if (!config.slackWebhookUrl) errors.push('SLACK_WEBHOOK_URL 미설정');

  if (errors.length > 0) {
    log.error('설정 오류:');
    errors.forEach((e) => log.error(` - ${e}`));
    process.exit(1);
  }

  log.success('설정 검증 완료');
  log.info(`Account ID: ${config.newRelicAccountId}`);
  log.info(`App Name: ${config.newRelicAppName}`);
  log.info(`Hostname LIKE: ${config.newRelicHostnameLike}`);
  log.info(`Schedule: ${config.scheduleInterval}`);
}

// ============ New Relic GraphQL 호출 ============
async function callNewRelicGraphQL(query) {
  const response = await axios.post(
    'https://api.newrelic.com/graphql',
    { query },
    {
      headers: {
        'API-Key': config.newRelicApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  if (response.data.errors && response.data.errors.length > 0) {
    throw new Error(response.data.errors[0].message);
  }

  return response.data?.data;
}

// ============ 메트릭 조회 ============
async function fetchMetrics() {
  log.info('New Relic 데이터 수집 시작');

  const queries = {
    transactions: `
      {
        actor {
          account(id: ${config.newRelicAccountId}) {
            nrql(
              query: "SELECT count(*) as total, percentage(count(*), WHERE error is true) as errorRate FROM Transaction WHERE appName = '${config.newRelicAppName}' SINCE 1 hour ago"
            ) {
              results
            }
          }
        }
      }
    `,
    resources: `
      {
        actor {
          account(id: ${config.newRelicAccountId}) {
            nrql(
              query: "SELECT average(processCpuPercent) as cpu, average(memoryUsagePercent) as memory FROM ProcessSample WHERE hostname LIKE '${config.newRelicHostnameLike}' SINCE 1 hour ago"
            ) {
              results
            }
          }
        }
      }
    `,
    apdex: `
      {
        actor {
          account(id: ${config.newRelicAccountId}) {
            nrql(
              query: "SELECT apdex(duration, t: 0.5) as score FROM Transaction WHERE appName = '${config.newRelicAppName}' SINCE 1 hour ago"
            ) {
              results
            }
          }
        }
      }
    `
  };

  const results = {};

  for (const [key, query] of Object.entries(queries)) {
    try {
      const data = await callNewRelicGraphQL(query);
      results[key] = data?.actor?.account?.nrql?.results?.[0] || {};
      log.success(`${key} 조회 성공`);
    } catch (err) {
      log.error(`${key} 조회 실패: ${err.message}`);
      results[key] = {};
    }
  }

  const metrics = {
    totalTransactions: Math.round(results.transactions.total || 0),
    errorRate: Number(results.transactions.errorRate || 0),
    successRate: 100 - Number(results.transactions.errorRate || 0),
    avgCpu: Number(results.resources.cpu || 0),
    avgMemory: Number(results.resources.memory || 0),
    apdexScore: Number(results.apdex.score || 0),
    timestamp: moment().tz(config.timezone).format('YYYY-MM-DD HH:mm:ss')
  };

  log.info(`수집 결과: ${JSON.stringify(metrics)}`);
  return metrics;
}

// ============ 건강도 평가 ============
function evaluateHealth(metrics) {
  let health = 'GOOD';
  let score = 100;
  const issues = [];

  const errorRate = Number(metrics.errorRate);
  const cpu = Number(metrics.avgCpu);
  const memory = Number(metrics.avgMemory);
  const apdex = Number(metrics.apdexScore);

  if (errorRate > 1) {
    health = 'CRITICAL';
    score -= 40;
    issues.push(`🔴 높은 오류율: ${errorRate.toFixed(2)}%`);
  } else if (errorRate > 0.5) {
    health = 'WARNING';
    score -= 20;
    issues.push(`🟡 주의 오류율: ${errorRate.toFixed(2)}%`);
  }

  if (cpu > 80) {
    health = 'CRITICAL';
    score -= 30;
    issues.push(`🔴 높은 CPU: ${cpu.toFixed(2)}%`);
  } else if (cpu > 60) {
    if (health !== 'CRITICAL') health = 'WARNING';
    score -= 15;
    issues.push(`🟡 CPU 주의: ${cpu.toFixed(2)}%`);
  }

  if (memory > 85) {
    health = 'CRITICAL';
    score -= 30;
    issues.push(`🔴 높은 메모리: ${memory.toFixed(2)}%`);
  } else if (memory > 70) {
    if (health !== 'CRITICAL') health = 'WARNING';
    score -= 15;
    issues.push(`🟡 메모리 주의: ${memory.toFixed(2)}%`);
  }

  if (apdex < 0.8) {
    if (health !== 'CRITICAL') health = 'WARNING';
    score -= 15;
    issues.push(`🟡 응답 품질 저하(Apdex): ${apdex.toFixed(3)}`);
  }

  if (issues.length === 0) {
    health = score >= 95 ? 'EXCELLENT' : 'GOOD';
    issues.push('✅ 시스템 정상');
  }

  return {
    health,
    score: Math.max(0, score),
    issues
  };
}

// ============ 결과 저장 ============
function saveResult(metrics, evaluation) {
  try {
    ensureLogDir();
    const now = moment().tz(config.timezone).format('YYYYMMDD-HHmmss');
    const filePath = path.join(config.logDir, `result-${now}.json`);

    const payload = {
      config: {
        newRelicAccountId: config.newRelicAccountId,
        newRelicAppName: config.newRelicAppName,
        newRelicHostnameLike: config.newRelicHostnameLike,
        timezone: config.timezone
      },
      metrics,
      evaluation
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    log.success(`결과 저장 완료: ${filePath}`);
  } catch (error) {
    log.error(`결과 저장 실패: ${error.message}`);
  }
}

// ============ Slack 메시지 생성 ============
function buildSlackPayload(metrics, evaluation) {
  const colorMap = {
    CRITICAL: '#E74C3C',
    WARNING: '#F39C12',
    GOOD: '#3498DB',
    EXCELLENT: '#27AE60'
  };

  const mentionPrefix =
    evaluation.health === 'CRITICAL' && config.enableChannelMentionOnCritical
      ? '<!channel>\n'
      : '';

  return {
    text: `${mentionPrefix}[Pongift] 대시보드 리포트 - ${evaluation.health}`,
    attachments: [
      {
        color: colorMap[evaluation.health] || '#3498DB',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `Pongift 대시보드 리포트 - ${evaluation.health}`
            }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*점수*\n${evaluation.score}` },
              { type: 'mrkdwn', text: `*기준 시각*\n${metrics.timestamp}` },
              { type: 'mrkdwn', text: `*총 트랜잭션*\n${metrics.totalTransactions}` },
              { type: 'mrkdwn', text: `*오류율*\n${Number(metrics.errorRate).toFixed(2)}%` },
              { type: 'mrkdwn', text: `*성공률*\n${Number(metrics.successRate).toFixed(2)}%` },
              { type: 'mrkdwn', text: `*CPU*\n${Number(metrics.avgCpu).toFixed(2)}%` },
              { type: 'mrkdwn', text: `*메모리*\n${Number(metrics.avgMemory).toFixed(2)}%` },
              { type: 'mrkdwn', text: `*Apdex*\n${Number(metrics.apdexScore).toFixed(3)}` }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*주요 이슈*\n${evaluation.issues.map((v) => `• ${v}`).join('\n')}`
            }
          }
        ]
      }
    ]
  };
}

// ============ Slack 발송 ============
async function sendSlackMessage(metrics, evaluation) {
  log.info('Slack 발송 시작');

  const payload = buildSlackPayload(metrics, evaluation);

  await axios.post(config.slackWebhookUrl, payload, {
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });

  log.success('Slack 발송 완료');
}

// ============ 1회 실행 ============
async function runAnalysis() {
  log.info('분석 작업 시작');

  try {
    const metrics = await fetchMetrics();
    const evaluation = evaluateHealth(metrics);

    log.info(`건강도 평가: ${evaluation.health} / ${evaluation.score}점`);
    evaluation.issues.forEach((issue) => log.info(issue));

    saveResult(metrics, evaluation);
    await sendSlackMessage(metrics, evaluation);

    log.success('분석 작업 완료');
  } catch (error) {
    log.error(`분석 작업 실패: ${error.message}`);
  }
}

// ============ 메인 ============
async function main() {
  validateConfig();

  const runOnce = process.argv.includes('--run-once');

  if (runOnce) {
    log.info('단일 실행 모드');
    await runAnalysis();
    process.exit(0);
  }

  log.info('초기 1회 실행');
  await runAnalysis();

  log.info(`스케줄러 등록: ${config.scheduleInterval}`);
  cron.schedule(
    config.scheduleInterval,
    async () => {
      await runAnalysis();
    },
    {
      timezone: config.timezone
    }
  );

  log.success('스케줄러 실행 중');
}

main().catch((err) => {
  log.error(`치명적 오류: ${err.message}`);
  process.exit(1);
});
