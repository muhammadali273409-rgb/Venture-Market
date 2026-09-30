import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  /**
   * The Buyer/Seller choice from onboarding — required, so an account is
   * never created with a role the user didn't pick. ADMIN (or anything
   * else) is rejected here; admins are provisioned via admin:bootstrap.
   */
  @IsIn(['BUYER', 'SELLER'])
  role!: 'BUYER' | 'SELLER';
}
