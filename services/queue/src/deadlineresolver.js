let debug = require('debug')('app:deadline-resolver');
let slugid = require('slugid');
let assert = require('assert');
let _ = require('lodash');
let data = require('./data');
let QueueService = require('./queueservice');
let events = require('events');
let Iterate = require('taskcluster-lib-iterate');

/** State that are considered resolved */
const RESOLVED_STATES = [
  'completed',
  'failed',
  'exception',
];

/**
 * Facade that handles resolution tasks by deadline, using the advisory messages
 * from the azure queue. The azure queue messages takes the form:
 * `{taskId, deadline}`, and they become visible after `deadline` has been
 * exceeded. The messages advice that if a task with the given `deadline` and
 * `taskId` exists, then it be resolved by deadline, if not already resolved.
 *
 * Notice, that the task may not exists. Or the task may have different
 * `deadline`, we shall only handle task if the `deadline` match.
 *
 * The deadline message serves 3 purposes:
 * A) Resolve old tasks
 * B) Resolve tasks that failed to create properly
 * C) Clean up TaskGroupActiveSet and publish message about task-group finished.
 */
class DeadlineResolver {
  /**
   * Create DeadlineResolver instance.
   *
   * options:
   * {
   *   Task:              // instance of data.Task
   *   queueService:      // instance of QueueService
   *   dependencyTracker: // instance of DependencyTracker
   *   publisher:         // publisher from base.Exchanges
   *   pollingDelay:      // Number of ms to sleep between polling
   *   parallelism:       // Number of polling loops to run in parallel
   *                      // Each handles up to 32 messages in parallel
   *   monitor:           // base.monitor instance
   * }
   */
  constructor(options) {
    assert(options, 'options must be given');
    assert(options.Task.prototype instanceof data.Task,
      'Expected data.Task instance');
    assert(options.queueService instanceof QueueService,
      'Expected instance of QueueService');
    assert(options.dependencyTracker, 'Expected a DependencyTracker instance');
    assert(options.publisher, 'Expected a publisher');
    assert(typeof options.pollingDelay === 'number',
      'Expected pollingDelay to be a number');
    assert(typeof options.parallelism === 'number',
      'Expected parallelism to be a number');
    assert(options.monitor !== null, 'options.monitor required!');
    this.Task = options.Task;
    this.queueService = options.queueService;
    this.dependencyTracker = options.dependencyTracker;
    this.publisher = options.publisher;
    this.pollingDelay = options.pollingDelay;
    this.parallelism = options.parallelism;
    this.monitor = options.monitor;

    const pollingDelaySecs = this.pollingDelay / 1000;
    const maxIterationTimeSecs = 600;
    this.iterator = new Iterate({
      maxFailures: 10,
      waitTime: pollingDelaySecs,
      watchDog: maxIterationTimeSecs + 1, // disable watchdog
      monitor: this.monitor,
      maxIterationTime: maxIterationTimeSecs,
      handler: async () => {
        let loops = [];
        for (var i = 0; i < this.parallelism; i++) {
          loops.push(this.poll());
        }
        await Promise.all(loops);
      },
    });
  }

  /** Start polling */
  async start() {
    return new Promise((res, rej) => {
      this.iterator.once('started', res);
      this.iterator.start();
    });
  }

  /** Terminate iteration, returns promise that polling is stopped */
  terminate() {
    return new Promise((res, rej) => {
      this.iterator.once('stopped', res);
      this.iterator.stop();
    });
  }

  /** Poll for messages and handle them in a loop */
  async poll() {
    var messages = await this.queueService.pollDeadlineQueue();
    debug('Fetched %s messages', messages.length);

    await Promise.all(messages.map(async (message) => {
      // Don't let a single task error break the loop, it'll be retried later
      // as we don't remove message unless they are handled
      try {
        await this.handleMessage(message);
      } catch (err) {
        this.monitor.reportError(err, 'warning');
      }
    }));

    if (messages.length === 0 && !this.stopping) {
      // Count that the queue is empty, we should have this happen regularly.
      // otherwise, we're not keeping up with the messages. We can setup
      // alerts to notify us if this doesn't happen for say 40 min.
      this.monitor.count('deadline-queue-empty');
    }
  }

  /** Sleep for `delay` ms, returns a promise */
  sleep(delay) {
    return new Promise((accept) => { setTimeout(accept, delay); });
  }

  /** Handle advisory message about deadline expiration */
  async handleMessage({taskId, taskGroupId, schedulerId, deadline, remove}) {
    // Query for entity for which we have exact rowKey too, limit to 1, and
    // require that deadline matches. This is essentially a conditional load
    // operation
    var {entries: [task]} = await this.Task.query({
      taskId: taskId, // Matches an exact entity
      deadline: deadline, // Load conditionally
    }, {
      matchRow: 'exact', // Validate that we match row key exactly
      limit: 1, // Load at most one entity, no need to search
    });

    // If the task doesn't exist we're done
    if (!task) {
      await this.dependencyTracker.updateTaskGroupActiveSet(taskId, taskGroupId, schedulerId);
      return remove();
    }

    // Check if this is the deadline we're supposed to be resolving for, if
    // this check fails, then the conditional load must have failed so we should
    // report error
    if (task.deadline.getTime() !== deadline.getTime()) {
      let err = new Error('Task deadline does not match deadline from ' +
                    'message, taskId: ' + taskId + ' this only happens ' +
                    'if conditional load does not work');
      err.taskId = taskId;
      err.taskDeadline= task.deadline.toJSON();
      err.messageDeadline= deadline.toJSON();
      await this.monitor.reportError(err);
      return remove();
    }

    // Ensure that all runs are resolved
    await task.modify((task) => {
      // If there is no run, we add a new one to signal that the task is
      // resolved. As this run is purely to signal an exception, we set
      // `reasonCreated: 'exception'`.
      if (task.runs.length === 0) {
        var now = new Date().toJSON();
        task.runs.push({
          state: 'exception',
          reasonCreated: 'exception',
          reasonResolved: 'deadline-exceeded',
          scheduled: now,
          resolved: now,
        });
      }

      task.runs.forEach((run, runId) => {
        // don't modify resolved runs
        if (_.includes(RESOLVED_STATES, run.state)) {
          return;
        }

        // If a run that isn't the last run is unresolved, it violates an
        // invariant and we shall log and error...
        if (task.runs.length - 1 !== runId) {
          let err = new Error('runId: ' + runId + ' is not the last of: ' +
                              taskId + ' but it is not resolved');
          err.taskId = taskId;
          err.runId = runId;
          err.run = run;
          this.monitor.reportError(err);
        }

        // Resolve run as deadline-exceeded
        run.state = 'exception';
        run.reasonResolved = 'deadline-exceeded';
        run.resolved = new Date().toJSON();
      });

      // Clear takenUntil, for ClaimResolver
      task.takenUntil = new Date(0);
    });

    // Check if the last run was resolved here
    var run = _.last(task.runs);
    if (run.reasonResolved === 'deadline-exceeded' &&
        run.state === 'exception') {
      debug('Resolved taskId: %s, by deadline', taskId);

      // Update dependency tracker
      await this.dependencyTracker.resolveTask(taskId, task.taskGroupId, task.schedulerId, 'exception');

      // Publish messages about the last run
      await this.publisher.taskException({
        status: task.status(),
        runId: task.runs.length - 1,
      }, task.routes);
    }

    return remove();
  }
}

// Export DeadlineResolver
module.exports = DeadlineResolver;
