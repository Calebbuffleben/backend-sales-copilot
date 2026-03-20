import { Controller, Get, Param } from '@nestjs/common';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get('metrics/:meetingId')
  async getMetrics(@Param('meetingId') meetingId: string) {
    return this.feedbackService.getFeedbackMetrics(meetingId);
  }
}
