const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');

function buildYouTubeVideoMetadata(scheduleEntry, options, now, defaultPrivacyStatus) {
  const { metadata } = scheduleEntry;
  const validation = assertValidYouTubeMetadata(metadata.seo);
  const safeMetadata = validation.value;
  const requestedPrivacy = metadata.privacyStatus || defaultPrivacyStatus || 'private';
  const scheduledFor = new Date(scheduleEntry.publishTime);
  const futureSchedule = !options.publishNow && Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > now + 60000;
  const videoMetadata = {
    snippet: {
      title: safeMetadata.title,
      description: safeMetadata.description,
      tags: safeMetadata.tags,
      categoryId: safeMetadata.categoryId,
      defaultLanguage: safeMetadata.defaultLanguage,
      defaultAudioLanguage: safeMetadata.defaultAudioLanguage
    },
    status: {
      privacyStatus: futureSchedule ? 'private' : requestedPrivacy,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: metadata.containsSyntheticMedia === true
    }
  };
  if (futureSchedule) videoMetadata.status.publishAt = scheduleEntry.publishTime;

  return { validation, videoMetadata };
}

class PublishingSchedulingAgent {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
    this.draftOnlyMode = process.env.YOUTUBE_AUTOMATION_DRAFT_ONLY === 'true' || options.draftOnly === true;
  }

  assertPublishingEnabled(operation = 'Publishing') {
    if (!this.draftOnlyMode) return;
    const error = new Error(`${operation} is disabled in draft-only mode`);
    error.status = 403;
    error.code = 'DRAFT_ONLY_PUBLISHING_DISABLED';
    throw error;
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    if (this.draftOnlyMode) {
      this.publishQueue = [];
      this.logger.info('Draft-only mode: YouTube authorization and publish queue remain dormant');
      return true;
    }
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    this.assertPublishingEnabled('YouTube authorization');
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

  async scheduleContent(productionData, approvalContext = null) {
    this.assertPublishingEnabled('Scheduling');
    try {
      const candidate = await this.prepareScheduleEntry(productionData);
      if (!candidate) return null;

      let approval = await this.db.getContentApproval?.(productionData.id);
      if (productionData.contentType === 'short' && approvalContext?.type === 'short' && approvalContext.confirmed === true) {
        const sourceApproval = await this.db.getContentApproval?.(approvalContext.sourceProductionId);
        const short = await this.db.getShortClip?.(approvalContext.clipId);
        approval = sourceApproval?.status === 'approved' && short?.status === 'rendered' ? sourceApproval : null;
      }
      if (approval?.status !== 'approved') {
        const error = new Error('Content cannot be scheduled until it has explicit operator approval');
        error.status = 409;
        error.code = 'CONTENT_NOT_APPROVED';
        throw error;
      }

      this.logger.info(`Scheduling content: ${productionData.id}`);
      const existing = await this.db.getLatestScheduleEntry?.(productionData.id);
      if (existing) {
        if (['scheduled', 'paused'].includes(existing.status) && !this.publishQueue.some(entry => entry.id === existing.id)) {
          this.publishQueue.push(existing);
          this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        }
        this.logger.info(`Reusing existing ${existing.status} schedule entry for: ${productionData.id}`);
        return existing;
      }

      const saved = this.db.saveScheduleEntryWithApproval
        ? await this.db.saveScheduleEntryWithApproval(candidate, approval.contentRevision, {
          ...approvalContext, confirmed: approvalContext?.confirmed === true
        })
        : await this.db.saveScheduleEntry(candidate) || candidate;
      this.publishQueue.push(saved);
      this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      this.logger.info(`Content scheduled for: ${saved.publishTime}`);
      return saved;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  async prepareScheduleEntry(productionData, existing = {}) {
    const finalVideo = productionData.assets?.finalVideo;
    if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
      this.logger.warn(`Not scheduling ${productionData.id}: no real video file was produced (placeholder/simulated output). Fix your AI provider keys and FFmpeg, then regenerate.`);
      return null;
    }
    if (!await this.isNarrationReady(productionData.assets?.audio)) {
      this.logger.warn(`Not scheduling ${productionData.id}: narration is missing. Regenerate narration or explicitly confirm an intentional silent video.`);
      return null;
    }
    return {
      ...existing,
      productionId: productionData.id,
      title: productionData.script.title,
      publishTime: productionData.scheduledPublishTime,
      status: 'scheduled',
      priority: productionData.priority,
      metadata: {
        ...(existing.metadata || {}),
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: productionData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia === true,
        contentType: productionData.contentType || 'long_form',
        sourceProductionId: productionData.sourceProductionId || productionData.id,
        shortClipId: productionData.shortClipId || null
      },
      createdAt: existing.createdAt || new Date().toISOString()
    };
  }

  async publishContent(contentId, options = {}) {
    this.assertPublishingEnabled();
    try {
      let productionBundle = null;
      if (this.db.getLatestReadinessRun) {
        const readiness = await this.db.getLatestReadinessRun();
        if (readiness?.status === 'failed') {
          const failures = readiness.checks
            .filter(check => check.blocking && check.status === 'failed')
            .map(check => check.id);
          const error = new Error(`Publishing is blocked by the production readiness gate. Fix ${failures.join(', ')} and run the check again.`);
          error.status = 409;
          error.code = 'READINESS_BLOCKED';
          throw error;
        }
      }
      if (this.db.getProductionBundle) {
        productionBundle = await this.db.getProductionBundle(contentId);
        if (productionBundle && !['verified', 'not_required'].includes(productionBundle.provenance?.status || 'not_required')) {
          const error = new Error('Publishing is blocked until every factual claim is supported or explicitly waived');
          error.status = 409;
          error.code = 'PROVENANCE_BLOCKED';
          throw error;
        }
      }
      this.logger.info(`Publishing content: ${contentId}`);
      
      let scheduleEntry = this.publishQueue.find(entry =>
        entry.productionId === contentId || entry.id === contentId
      );
      if (!scheduleEntry && this.db.getLatestScheduleEntry) {
        scheduleEntry = await this.db.getLatestScheduleEntry(contentId);
      }
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      scheduleEntry = { ...scheduleEntry };
      if (scheduleEntry.status === 'published') return scheduleEntry;
      if (!await this.isNarrationReady(scheduleEntry.metadata?.audio || productionBundle?.assets?.audio)) {
        const error = new Error('Publishing is blocked because narration is missing or the intentional-silence override is incomplete');
        error.status = 409;
        error.code = 'NARRATION_REQUIRED';
        throw error;
      }
      const approval = await this.requireCurrentApproval(scheduleEntry);
      if (scheduleEntry.youtubeId) {
        return this.reconcileUploadedVideo(scheduleEntry, approval.contentRevision);
      }
      if (['uploading', 'reconciliation_required'].includes(scheduleEntry.status)) {
        const error = new Error('A previous upload may have reached YouTube without returning a video ID. Reconcile the channel before attempting another upload.');
        error.status = 409;
        error.code = 'UPLOAD_OUTCOME_UNKNOWN';
        throw error;
      }

      scheduleEntry.status = 'uploading';
      scheduleEntry.error = null;
      await this.persistApprovedScheduleEntry(scheduleEntry, approval.contentRevision);
      await this.syncShortStatus(scheduleEntry, 'uploading');
      
      let uploadResult;
      try {
        uploadResult = await this.uploadToYouTube(scheduleEntry, options);
      } catch (error) {
        if (scheduleEntry.uploadAttempted && this.isUploadOutcomeUnknown(error)) {
          scheduleEntry.status = 'reconciliation_required';
          scheduleEntry.error = 'Upload outcome is unknown; verify the YouTube channel before retrying';
          await this.persistApprovedScheduleEntry(scheduleEntry, approval.contentRevision);
          await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          error.status = 409;
        } else {
          scheduleEntry.status = 'failed';
          scheduleEntry.error = error.message;
          await this.persistApprovedScheduleEntry(scheduleEntry, approval.contentRevision);
          await this.syncShortStatus(scheduleEntry, 'failed', error.message);
        }
        throw error;
      }
      
      // Update database
      scheduleEntry.status = 'published';
      scheduleEntry.publishedAt = new Date().toISOString();
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      
      await this.persistApprovedScheduleEntry(scheduleEntry, approval.contentRevision, { productionStatus: 'published' });
      await this.syncShortStatus(scheduleEntry, 'published');
      
      // Remove from queue
      this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
      
      this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
      return scheduleEntry;
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry, options = {}) {
    // Draft-only mode: block every YouTube upload, including direct calls.
    const error = new Error('YouTube uploads are disabled. Review and approve the video first.');
    error.status = 403;
    error.code = 'YOUTUBE_UPLOAD_DISABLED';
    throw error;

    const { validation, videoMetadata } = buildYouTubeVideoMetadata(
      scheduleEntry, options, Date.now(), process.env.DEFAULT_PRIVACY_STATUS
    );
    if (validation.warnings.length) {
      this.logger.warn(`YouTube metadata warnings: ${validation.warnings.join(' ')}`);
    }
    const { metadata } = scheduleEntry;
    
    // Resolve the file before marking the network upload as attempted.
    const videoStream = await this.getVideoStream(metadata.video.path);
    scheduleEntry.uploadAttempted = true;
    const videoUpload = await this.youtube.videos.insert({
      part: 'snippet,status',
      requestBody: videoMetadata,
      media: {
        body: videoStream
      }
    });
    
    const videoId = videoUpload.data.id;
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    scheduleEntry.status = 'uploaded';
    scheduleEntry.youtubeId = videoId;
    scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    
    // Upload thumbnail
    if (metadata.thumbnail && metadata.thumbnail.path) {
      await this.uploadThumbnail(videoId, metadata.thumbnail.path);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }

  async isNarrationReady(audio = {}) {
    if (audio.intentionalSilence === true) {
      return String(audio.silenceReason || '').trim().length >= 10 && Boolean(audio.silenceConfirmedAt);
    }
    if (!audio.path || audio.simulated || String(audio.path).endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audio.path);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isUploadOutcomeUnknown(error) {
    const status = Number(error.status || error.response?.status || 0);
    return !status || status >= 500;
  }

  async reconcileUploadedVideo(scheduleEntry, expectedRevision) {
    this.assertPublishingEnabled();
    const response = await this.youtube.videos.list({ part: 'id,status', id: scheduleEntry.youtubeId });
    if (!response.data.items?.some(video => video.id === scheduleEntry.youtubeId)) {
      scheduleEntry.status = 'reconciliation_required';
      scheduleEntry.error = 'The recorded YouTube video ID could not be verified';
      await this.persistApprovedScheduleEntry(scheduleEntry, expectedRevision);
      await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
      const error = new Error('The recorded upload could not be verified on YouTube. Resolve it before attempting another upload.');
      error.status = 409;
      error.code = 'UPLOAD_OUTCOME_UNKNOWN';
      throw error;
    }
    scheduleEntry.status = 'published';
    scheduleEntry.publishedAt = scheduleEntry.publishedAt || new Date().toISOString();
    scheduleEntry.youtubeUrl = scheduleEntry.youtubeUrl || `https://www.youtube.com/watch?v=${scheduleEntry.youtubeId}`;
    scheduleEntry.error = null;
    await this.persistApprovedScheduleEntry(scheduleEntry, expectedRevision, { productionStatus: 'published' });
    await this.syncShortStatus(scheduleEntry, 'published');
    this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
    this.logger.success(`Reconciled existing YouTube upload: ${scheduleEntry.youtubeUrl}`);
    return scheduleEntry;
  }

  async syncShortStatus(scheduleEntry, status, error = null) {
    const clipId = scheduleEntry.metadata?.shortClipId;
    if (!clipId || !this.db.updateShortClip) return null;
    return this.db.updateShortClip(clipId, {
      status,
      scheduleId: scheduleEntry.id,
      youtubeId: scheduleEntry.youtubeId || null,
      youtubeUrl: scheduleEntry.youtubeUrl || null,
      error
    });
  }

  async getVideoStream(videoPath) {
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
        throw new Error('placeholder asset');
      }

      return fsSync.createReadStream(videoPath);
    } catch (error) {
      throw new Error('video file not found — refusing to upload placeholder');
    }
  }
  async uploadThumbnail(videoId, thumbnailPath) {
    const error = new Error('YouTube uploads and metadata updates are disabled in draft-only mode');
    error.status = 403;
    error.code = 'YOUTUBE_UPLOAD_DISABLED';
    throw error;

    try {
      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      
      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      
      this.logger.info(`Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload thumbnail: ${error.message}`);
    }
  }

  async applyVideoPackaging(videoId, packaging = {}, previousPackaging = null) {
    const error = new Error('YouTube uploads and metadata updates are disabled in draft-only mode');
    error.status = 403;
    error.code = 'YOUTUBE_UPLOAD_DISABLED';
    throw error;

    const title = String(packaging.title || '').trim();
    if (!videoId || !title || title.length > 100 || !packaging.thumbnailPath) {
      const error = new Error('A valid video ID, title, and thumbnail are required for a packaging change');
      error.status = 400;
      error.code = 'PACKAGING_INVALID';
      throw error;
    }
    const thumbnail = await fs.readFile(packaging.thumbnailPath);
    const current = await this.youtube.videos.list({ part: 'snippet', id: videoId });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) {
      const error = new Error(`YouTube video not found: ${videoId}`);
      error.status = 404;
      error.code = 'PACKAGING_VIDEO_NOT_FOUND';
      throw error;
    }

    const updateTitle = async nextTitle => this.youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: nextTitle,
          description: snippet.description || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '22',
          defaultLanguage: snippet.defaultLanguage,
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });

    await updateTitle(title);
    try {
      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnail }
      });
    } catch (error) {
      try {
        await updateTitle(String(previousPackaging?.title || snippet.title || '').trim());
      } catch (rollbackError) {
        error.message = `${error.message}; title rollback also failed: ${rollbackError.message}`;
      }
      throw error;
    }
    this.logger.info(`Applied approved growth-experiment packaging to video: ${videoId}`);
    return { videoId, title, thumbnailPath: packaging.thumbnailPath };
  }

  async uploadCaptions(videoId, captionsPath) {
    const error = new Error('YouTube uploads and metadata updates are disabled in draft-only mode');
    error.status = 403;
    error.code = 'YOUTUBE_UPLOAD_DISABLED';
    throw error;

    try {
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language: 'en',
            name: 'English Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    this.assertPublishingEnabled('Publish queue processing');
    const now = new Date();
    const scheduled = this.publishQueue
      .filter(entry => entry.status === 'scheduled')
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    const readyToPublish = scheduled.filter(entry => new Date(entry.publishTime) <= now);

    if (readyToPublish.length === 0) {
      if (scheduled.length > 0) {
        this.logger.info(`Publish queue: ${scheduled.length} item(s) waiting, next publish at ${scheduled[0].publishTime}`);
      } else {
        this.logger.info('Publish queue is empty — nothing scheduled yet.');
      }
      return 0;
    }

    this.logger.info(`Processing publish queue: ${readyToPublish.length} item(s) ready to publish...`);

    for (const entry of readyToPublish) {
      try {
        if (!await this.isEntryApproved(entry)) {
          this.logger.warn(`Skipping ${entry.title}: explicit approval is required`);
          continue;
        }
        await this.publishContent(entry.productionId);
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        if (error.code === 'READINESS_BLOCKED' || error.code === 'CONTENT_NOT_APPROVED') {
          this.logger.warn(error.message);
          continue;
        }
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        if (error.code !== 'UPLOAD_OUTCOME_UNKNOWN') {
          try {
            const approval = await this.requireCurrentApproval(entry);
            const failedEntry = { ...entry, status: 'failed', error: error.message };
            await this.persistApprovedScheduleEntry(failedEntry, approval.contentRevision);
          } catch (approvalError) {
            if (approvalError.code !== 'CONTENT_NOT_APPROVED') throw approvalError;
            this.logger.warn(`Leaving ${entry.title} unchanged because approval is no longer current`);
          }
        }
      }
    }
    
    return readyToPublish.length;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          try {
            const approval = await this.requireCurrentApproval(entry);
            const updated = { ...entry, publishTime: betterTime.toISOString() };
            await this.persistApprovedScheduleEntry(updated, approval.contentRevision, {
              invalidateApproval: true, productionStatus: 'scheduled'
            });
            this.logger.info(`Optimized publish time for: ${entry.title}; fresh approval is required`);
          } catch (error) {
            if (error.code !== 'CONTENT_NOT_APPROVED') throw error;
          }
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    this.assertPublishingEnabled('Publishing and scheduling');
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);

    if (delayMinutes > 0) {
      const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId) ||
        await this.db.getLatestScheduleEntry?.(contentId);
      if (!entry) throw new Error(`Content not found: ${contentId}`);
      const approval = await this.requireCurrentApproval(entry);
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      const updated = { ...entry, publishTime: newPublishTime.toISOString() };
      await this.persistApprovedScheduleEntry(updated, approval.contentRevision, {
        invalidateApproval: true, productionStatus: 'scheduled'
      });
      this.logger.info(`Emergency scheduled for: ${updated.publishTime}`);
      return updated;
    }
    return this.publishContent(contentId, { publishNow: true });
  }

  async pauseScheduledContent(contentId) {
    this.assertPublishingEnabled('Scheduling');
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }

    const approval = await this.requireCurrentApproval(entry);
    const updated = { ...entry, status: 'paused' };
    await this.persistApprovedScheduleEntry(updated, approval.contentRevision);
    
    this.logger.info(`Content paused: ${updated.title}`);
    return updated;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    this.assertPublishingEnabled('Scheduling');
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }

    const approval = await this.requireCurrentApproval(entry);
    const updated = { ...entry, status: 'scheduled' };
    if (newPublishTime) {
      updated.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.persistApprovedScheduleEntry(updated, approval.contentRevision, {
      invalidateApproval: Boolean(newPublishTime),
      productionStatus: 'scheduled'
    });
    
    this.logger.info(`Content resumed: ${updated.title}`);
    return updated;
  }

  async rescheduleContent(contentId, newPublishTime) {
    this.assertPublishingEnabled('Scheduling');
    const publishTime = new Date(newPublishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) {
      const error = new Error('Choose a future publish time');
      error.status = 400;
      throw error;
    }
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    const approval = await this.requireCurrentApproval(entry);
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`Content cannot be rescheduled while it is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    const updated = { ...entry, publishTime: publishTime.toISOString(), status: 'scheduled', error: null };
    await this.persistApprovedScheduleEntry(updated, approval.contentRevision, {
      invalidateApproval: true, productionStatus: 'scheduled'
    });
    if (!this.publishQueue.some(item => item.id === updated.id)) this.publishQueue.push(updated);
    this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    return updated;
  }

  async deleteScheduledContent(contentId) {
    this.assertPublishingEnabled('Scheduling');
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    const approval = await this.requireCurrentApproval(entry);
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`The schedule cannot be deleted while content is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    if (this.db.deleteScheduleEntryWithApproval) {
      await this.db.deleteScheduleEntryWithApproval(entry, approval.contentRevision, {
        reviewNotes: 'Schedule deleted; approval is required before scheduling again',
        productionStatus: 'needs_review'
      });
    } else {
      await this.db.deleteScheduleEntry(entry.id);
    }
    this.publishQueue = this.publishQueue.filter(item => item.id !== entry.id);
    await this.syncShortStatus(entry, 'rendered');
    return entry;
  }

  async isEntryApproved(entry) {
    if (entry?.metadata?.contentType === 'short') {
      const sourceProductionId = entry.metadata.sourceProductionId;
      const shortClipId = entry.metadata.shortClipId;
      const approval = await this.db.getContentApproval?.(sourceProductionId);
      const clip = await this.db.getShortClip?.(shortClipId);
      return approval?.status === 'approved' && Boolean(clip?.approvedAt) &&
        ['scheduled', 'uploading', 'reconciliation_required', 'published'].includes(clip?.status) &&
        clip.inheritedEvidence?.sourceContentRevision === approval.contentRevision;
    }
    const approval = await this.db.getContentApproval?.(entry?.productionId);
    return approval?.status === 'approved';
  }

  async requireCurrentApproval(entry) {
    if (entry?.metadata?.contentType === 'short') {
      const sourceProductionId = entry.metadata.sourceProductionId;
      const shortClipId = entry.metadata.shortClipId;
      const approval = await this.db.getContentApproval?.(sourceProductionId);
      const clip = await this.db.getShortClip?.(shortClipId);
      if (approval?.status === 'approved' && Boolean(clip?.approvedAt) &&
        ['scheduled', 'uploading', 'reconciliation_required', 'published'].includes(clip?.status) &&
        clip.inheritedEvidence?.sourceContentRevision === approval.contentRevision) return approval;
      throw this.approvalError();
    }
    const approval = await this.db.getContentApproval?.(entry?.productionId);
    if (approval?.status === 'approved') return approval;
    throw this.approvalError();
  }

  async persistApprovedScheduleEntry(entry, expectedRevision, options = {}) {
    let saved;
    if (this.db.updateScheduleEntryWithApproval) {
      saved = await this.db.updateScheduleEntryWithApproval(entry, expectedRevision, options);
    } else {
      await this.db.updateScheduleEntry(entry);
      saved = entry;
    }
    const index = this.publishQueue.findIndex(item => item.id === entry.id);
    if (index >= 0) this.publishQueue[index] = saved || entry;
    return saved || entry;
  }

  approvalError() {
    const error = new Error('This schedule action requires current explicit operator approval');
    error.status = 409;
    error.code = 'CONTENT_NOT_APPROVED';
    throw error;
  }
}

module.exports = { PublishingSchedulingAgent, buildYouTubeVideoMetadata };
