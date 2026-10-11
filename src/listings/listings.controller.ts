import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ListingsService } from './listings.service';
import { Public } from '../common/decorators/public.decorator';
import { SearchListingsDto } from './dto/search-listings.dto';

@Controller('listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  /** Public marketplace search: filters, sorting and page-based pagination. */
  @Public()
  @Get()
  search(@Query() query: SearchListingsDto) {
    return this.listingsService.search(query);
  }

  /** Filter options derived from live listings (declared before :idOrSlug). */
  @Public()
  @Get('facets')
  facets() {
    return this.listingsService.facets();
  }

  @Public()
  @Get(':idOrSlug')
  getOne(@Param('idOrSlug') idOrSlug: string) {
    return this.listingsService.getPublicDetail(idOrSlug);
  }
}

@Controller('sellers')
export class SellersController {
  constructor(private readonly listingsService: ListingsService) {}

  /** Public seller profile; their listings come from GET /listings?sellerId=… */
  @Public()
  @Get(':id')
  getOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.listingsService.getPublicSeller(id);
  }
}
